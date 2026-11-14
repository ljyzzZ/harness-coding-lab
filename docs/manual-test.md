# 手动验收

本文用于验收终端、真实模型和人工审批的连接。它与自动化测试互补，不表示所有步骤已经执行通过。真实请求需要可用的 API Key，并会产生模型用量。

## 1. 安装与离线验证

在仓库根目录运行：

```bash
bun install --frozen-lockfile
bun run check:types
bun test
bun run examples/stage-10-text-client.ts
bun run examples/stage-09-coding-agent.ts fixture
```

预期：类型检查成功；测试无失败；Stage 10 输出 `assistant: client ready`；Stage 09 输出完成信息和已完成的 Todo。离线示例不会发出远程模型请求。

另行执行 `bun run lint`。当前版本存在 `typescript-eslint` 不支持 TypeScript 7.0 的已知阻塞，记录该失败，不将它算作通过。

## 2. 模型配置命令

在临时配置上操作，避免改变日常默认模型：

```bash
harness_config_test_dir="$(mktemp -d)"
harness_config_test_file="$harness_config_test_dir/config.yaml"

bun run dev --config "$harness_config_test_file" config model add first \
  --provider openai --model gpt-6-sol --api-key-env OPENAI_API_KEY
bun run dev --config "$harness_config_test_file" config model add second \
  --provider openai --model gpt-6-sol --api-key-env OPENAI_API_KEY
bun run dev --config "$harness_config_test_file" config model list
bun run dev --config "$harness_config_test_file" config model set-default second
bun run dev --config "$harness_config_test_file" config model remove first
bun run dev --config "$harness_config_test_file" config model list
```

预期：最初 `first` 是默认项，最后只保留默认项 `second`。重复添加同名配置、删除当前默认项、选择不存在的默认项应失败，且不损坏原配置。

这里只验证配置命令，不用临时配置调用模型。`add` 不自动添加模型专用 `options`；启动 GPT-6 Sol 工具调用前必须手动设置 `reasoning_effort: none`。

## 3. 启动与连续对话

按照 [README](../README.md) 配置 `.env` 和 `harness.config.yaml`，然后运行：

```bash
bun run dev
```

依次验证：

1. 初始界面为 `Ready`，模型名与 YAML 默认项一致。
2. 输入 `只回复 OK，不要调用工具`，等待回复并回到 `Ready`。
3. 再输入 `hello world，只回复 OK，不要调用工具`。
4. 继续输入一条不含空格的消息。

预期：多轮请求均成功；历史不重复；不存在 `tool_calls: empty array` 的 400 错误；收到 usage 后 Token 统计更新。

## 4. 文件审批与授权

对文件修改进行验收时，建议另开终端，在临时工作区运行 CLI。先在该终端导出 API Key；仓库目录的 `.env` 不应被假定会在其他工作目录自动加载。

```bash
# 在仓库根目录执行这几行；API Key 已通过环境变量提供
harness_lab_root="$PWD"
harness_tool_test_dir="$(mktemp -d)"
cd "$harness_tool_test_dir"
bun run "$harness_lab_root/src/cli/index.ts" \
  --config "$harness_lab_root/harness.config.yaml"
```

请求模型“使用 write_file 创建 hello.txt，内容为 hello，不执行 Bash”。模型行为可能不同，先确认界面展示的是预期工具及参数，再做下一步。

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 拒绝 | 按 `d` | 本次工具不执行，文件不创建，Agent 收到拒绝结果 |
| 允许一次 | 重新请求后按 `a` | 文件写入；后续同名工具仍需审批 |
| 项目级允许 | 再次请求相同工具后按 `p` | 保存该临时项目的工具授权；后续同名工具免询问 |
| 重启 | 退出后在同一临时目录重新启动 | 成功持久化的授权仍然生效 |
| 切换项目 | 从另一个临时目录启动 | 不复用原项目授权 |

项目授权位于 `~/.config/harness-lab/approvals.json`。验收结束后可在程序退出时仅移除临时工作区对应的条目，不要误删其他项目的授权。`/clear` 不撤销授权。

已知限制：保存授权的等待当前没有正确接收 `signal`。普通审批取消与“正在保存授权时取消”应区分记录，后者不能据此宣称已验收通过。

## 5. 用户提问

要求模型使用 `ask_user_question` 询问“使用 TypeScript 还是 JavaScript？”，提供两个选项。

预期：问题和选项显示在输入区；输入答案并回车后，答案作为对应工具结果返回，Agent 继续运行。空白答案不会提交。连续问题应使用各自的输入框状态，不能把前一题答案带入后一题。

## 6. 取消、清空与退出

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 模型运行中 | Ctrl+C | 请求取消，最终回到 `Ready`，不把正常 `AbortError` 展示为故障 |
| 等待审批 / 回答 | Ctrl+C | 当前输入请求被取消，输入界面消失，队列位置释放 |
| 空闲时 | `/clear` | 对话、Todo 和 Token 统计清零；下一轮模型不携带旧历史 |
| 空闲时 | `/help` | 显示 `/clear`、`/help`、`/exit` |
| 空闲时 | `/exit` 或 Ctrl+C | 进程退出，终端光标恢复 |

运行中再次输入消息不应开启重叠的一轮；清空操作只在空闲时允许。

## 7. 记录结果

记录分支或 commit、Bun 版本、provider / 模型、执行步骤、实际结果和错误信息。不要记录真实 API Key。区分已通过、未执行和已知阻塞，不把测试文件为空视为覆盖完成。

本次交付已验证类型检查、216 个自动化测试、TUI 启动、真实 GPT-6 Sol 文本流和函数工具调用，以及连续两轮对话；本清单其余交互项仍需按步骤单独验收。
