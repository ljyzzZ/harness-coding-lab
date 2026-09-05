import type { Message } from "@/foundation/messages";

import type { ModelContext } from "./model-context";
import type { ModelProvider, ModelProviderInvokeParams } from "./model-provider";

export class Model {
    readonly name: string;
    readonly provider: ModelProvider;
    readonly options?: Record<string, unknown>;

    constructor({
        name,
        provider,
        modelOptions,
    }: {
        name: string;
        provider: ModelProvider;
        modelOptions?: Record<string, unknown>;
    }) {
        this.name = name;
        this.provider = provider;
        this.options = modelOptions;
    }

    invoke(context: ModelContext) {
        // TODO 1：把 _buildProviderParams(context) 的结果传给 provider.invoke。
        // 返回值应保持 Promise<AssistantMessage>，不要在这里转换为字符串。
        return this.provider.invoke(this._buildProviderParams(context));
    }

    stream(context: ModelContext) {
        // TODO 2：把相同 params 传给 provider.stream 并直接返回 AsyncGenerator。
        return this.provider.stream(this._buildProviderParams(context));
    }

    private _buildProviderParams(context: ModelContext): ModelProviderInvokeParams {
        const messages: Message[] = [...context.messages];

        // TODO 3：context.prompt.trim() 非空时，在 messages 最前面放入 SystemMessage；
        // 不要 push 回 context.messages，否则每次请求都会永久复制 system prompt。
        if (context.prompt.trim() !== "") {
            messages.unshift({
                role: "system",
                content: [
                    {
                        type: "text",
                        text: context.prompt.trim()
                    }
                ]
            })
        }

        return {
            model: this.name,
            messages,
            tools: context.tools,
            options: this.options,
            signal: context.signal,
        };
    }
}