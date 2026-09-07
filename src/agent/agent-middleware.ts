import type { AssistantMessage, ToolUseContent } from "@/foundation/messages";
import type { ModelContext } from "@/foundation/models/model-context";

import type { AgentContext } from "./agent-context";

export interface AgentMiddleware {
  beforeAgentRun?(params: {
    agentContext: AgentContext;
  }): Promise<Partial<AgentContext> | void>;

  afterAgentRun?(params: {
    agentContext: AgentContext;
  }): Promise<Partial<AgentContext> | void>;

  beforeAgentStep?(params: {
    agentContext: AgentContext;
    step: number;
  }): Promise<Partial<AgentContext> | void>;

  afterAgentStep?(params: {
    agentContext: AgentContext;
    step: number;
  }): Promise<Partial<AgentContext> | void>;

  beforeModel?(params: {
    modelContext: ModelContext;
    agentContext: AgentContext;
  }): Promise<Partial<ModelContext> | void>;

  afterModel?(params: {
    agentContext: AgentContext;
    message: AssistantMessage;
  }): Promise<Partial<AssistantMessage> | void>;

  beforeToolUse?(params: {
    agentContext: AgentContext;
    toolUse: ToolUseContent;
  }): Promise<
    | Partial<AgentContext>
    | { __skip: true; result: unknown }
    | void
  >;

  afterToolUse?(params: {
    agentContext: AgentContext;
    toolUse: ToolUseContent;
    toolResult: unknown;
  }): Promise<Partial<AgentContext> | void>;
}