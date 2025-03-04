import { StateGraph, START, END } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { z } from "zod";
import { GenerativeUIAnnotation, GenerativeUIState } from "./types";
import { stockbrokerGraph } from "./stockbroker";
import { ChatOpenAI } from "@langchain/openai";
import { tripPlannerGraph } from "./trip-planner";

const allToolDescriptions = `- stockbroker: can fetch the price of a ticker, purchase/sell a ticker, or get the user's portfolio
- tripPlanner: helps the user plan their trip. it can suggest restaurants, and places to stay in any given location.`;

async function router(
  state: GenerativeUIState,
): Promise<Partial<GenerativeUIState>> {
  const routerDescription = `The route to take based on the user's input.
${allToolDescriptions}
- generalInput: handles all other cases where the above tools don't apply
`;
  const routerSchema = z.object({
    route: z
      .enum(["stockbroker", "tripPlanner", "generalInput"])
      .describe(routerDescription),
  });
  const routerTool = {
    name: "router",
    description: "A tool to route the user's query to the appropriate tool.",
    schema: routerSchema,
  };

  const llm = new ChatGoogleGenerativeAI({
    model: "gemini-2.0-flash",
    temperature: 0,
  })
    .bindTools([routerTool], { tool_choice: "router" })
    .withConfig({ tags: ["langsmith:nostream"] });

  const prompt = `You're a highly helpful AI assistant, tasked with routing the user's query to the appropriate tool.
You should analyze the user's input, and choose the appropriate tool to use.`;

  const recentHumanMessage = state.messages.findLast(
    (m) => m.getType() === "human",
  );

  if (!recentHumanMessage) {
    throw new Error("No human message found in state");
  }

  const response = await llm.invoke([
    { role: "system", content: prompt },
    recentHumanMessage,
  ]);

  const toolCall = response.tool_calls?.[0]?.args as
    | z.infer<typeof routerSchema>
    | undefined;
  if (!toolCall) {
    throw new Error("No tool call found in response");
  }

  return {
    next: toolCall.route,
  };
}

function handleRoute(
  state: GenerativeUIState,
): "stockbroker" | "tripPlanner" | "generalInput" {
  return state.next;
}

async function handleGeneralInput(state: GenerativeUIState) {
  const llm = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });
  const response = await llm.invoke([
    {
      role: "system",
      content: `You are an AI assistant.\nIf the user asks what you can do, describe these tools. Otherwise, just answer as normal.\n\n${allToolDescriptions}`,
    },
    ...state.messages,
  ]);

  return {
    messages: [response],
  };
}

const builder = new StateGraph(GenerativeUIAnnotation)
  .addNode("router", router)
  .addNode("stockbroker", stockbrokerGraph)
  .addNode("tripPlanner", tripPlannerGraph)
  .addNode("generalInput", handleGeneralInput)

  .addConditionalEdges("router", handleRoute, [
    "stockbroker",
    "tripPlanner",
    "generalInput",
  ])
  .addEdge(START, "router")
  .addEdge("stockbroker", END)
  .addEdge("tripPlanner", END)
  .addEdge("generalInput", END);

export const graph = builder.compile();
graph.name = "Generative UI Agent";
