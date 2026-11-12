# 仓库维护自动化

PR 维护只做两件事：**明确标题自动标签、CI 结束后更新一条简短评论**。不调用模型，不执行 PR 代码，不重复运行 CI。

## 1. 明确标题自动标签

| 标题 | 标签 |
| --- | --- |
| `fix: 修复会话恢复` | `bug` |
| `feat: 增加某个 Harness` | `enhancement` |
| `docs: 更新安装说明` | `documentation` |
| `调整会话处理` | 跳过，不猜测 |

支持 Conventional Commit 的 `(scope)` 和 `!`。不从正文、提交列表、文件路径或历史讨论推断类型；其他前缀不处理。不处理 Issue，包括历史 Issue。

只同步有标签事件证明属于本机器人的三种类型标签。人工或其他工具改过这类标签后停止自动同步；来源不明的现有标签不覆盖。标题变得无法识别时不再修改标签。不会批量删除仓库原有标签或创建领域标签。

## 2. CI 完成后的简短评论

成功示例：

> ✅ 提交 abc1234 的 CI 全部通过。

失败示例：

> ❌ macOS CI 失败。[查看日志](https://github.com/BytePioneer-AI/codex-host/actions)
>
> ```text
> src/foo.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.
> ```
>
> 提交 abc1234。

- 只读取 `.github/workflows/ci.yml` 中与 PR 当前 HEAD 对应的可信运行。等待工作流和所有 jobs 结束；排队、运行中或尚无运行时不新发评论。
- 只有工作流和所有 jobs 成功，且基线 job `Check macos-26` 有唯一成功证据，才报告全部通过。
- 等待批准、取消、跳过、超时、结果不完整分别说明，不能当作通过。CI API 读取失败不发布猜测结果。
- 每个 PR 只更新一条 `github-actions[bot]` 自有评论，兼容此前摘要标记；不会接管人工伪造的同名标记。结果未变化不重复写入，失败恢复后用成功结果替换。
- 评论显示短提交 SHA 并链接完整 SHA，避免新提交尚在运行时把上一轮结果误当成新结果；不会为了更新结果要求作者手填 SHA。
- 失败任务最多展示四个，每项最多摘录五行、每行最多 500 字符。保留错误原文，不翻译、不推断根因。优先提取 TypeScript、Rust、测试、npm 等可识别诊断；有失败 step 时间时只取该时间段。
- 移除日志时间戳和控制字符，脱敏凭据行、常见 Token、长疑似凭据、URL 和用户目录。脱敏是保守的模式匹配，不能保证发现所有未知秘密；CI 本身也不得输出秘密。
- 日志不可用、超过 8 MiB、下载超时或没有可识别错误时，只展示任务状态和 GitHub 日志链接，不复制完整日志或临时签名下载地址。

不再发布信息完整性、模板催补、审查汇总、规范风险、检查例外或长期等待提醒。不自动关闭、转 Draft、批准或合并。

## 触发与安全

入口：`.github/workflows/repository-maintenance.yml`。逻辑归属 `packages/repository-automation/`，可信工作流直接加载公共 `index.mjs`，无需安装依赖或构建。

- PR 创建、编辑、重开、提交或标签变化时同步；CI `workflow_run: completed` 时按实时 PR HEAD 查找目标。
- 不监听 Issue、讨论评论或 CodeRabbit status，不进行定时巡检。漏掉的事件可手动补跑。
- 手动执行必须选默认分支。`number` 指定 PR；留空处理开放 PR。默认 `dry_run=true`，不写评论或标签；指定编号时 Actions Summary 展示评论草稿。
- 已关闭、锁定或带 `automation:ignore` 的 PR 跳过。
- 使用可信默认分支代码、固定 Action SHA 和最小权限。不会 checkout / 执行 PR head、安装 PR 依赖、执行日志内容或传递凭据到日志下载站点。
- 评论和标签历史读取失败时不写入；写入前重新核对 PR 和 CI run/attempt，过期快照放弃。GitHub API 无跨接口事务，这不是分支保护或合并锁。
- 在 GitHub 中手动暂停的工作流，不会因本地代码修改自动恢复。重新启用和批量实际写入应由维护者明确决定。

## CI 执行范围和发布校验

此仓库的后续自动检查和构建仅使用 macOS。`ci.yml` 只有 `Check macos-26`，在原生 ARM64 runner 上执行完整验证，不再启动 Windows、Linux x64 或 Linux ARM64 job；手动运行 CI 也使用相同配置。仓库维护自动化同样使用 `macos-26`，权限和可信代码限制保持不变。

macOS CI 保留以下检查，不以缩减平台为由跳过原来由 Linux 承担的检查：

- 格式、ESLint、包边界和完整 TypeScript 类型检查（含测试）。
- TypeScript 和预装插件构建，以及完整 TypeScript / Web 测试，包括仓库治理、共享契约、Renderer 和 Gate 入口测试。
- 独立 Host 生命周期、Rust Clippy、编译和测试。
- macOS ARM64 npm 安装包 smoke，核对安装、可执行文件权限和版本。

完整测试项目的类型检查超过 macOS runner 上 Node 默认的 2 GiB 堆限制，因此仅 `Typecheck` step 设置 `NODE_OPTIONS=--max-old-space-size=4096`。不缩减类型检查范围，也不改变其他 step 或本地默认值。

CI 不设置 `CODEXHOST_TEST_SCOPE=platform` 或测试排除参数；该筛选仍可用于本地定向检查。Windows 和 Linux 的实现与本地工具不删除，但后续 CI 不再提供这两个平台的验证证据。macOS Intel 安装包仍由发布工作流在 `macos-15-intel` 上构建。

仅修改 `docs/**` 或 Markdown 文件的 PR 不触发 CI；没有新的 CI 运行时，维护自动化不会发布新的通过评论。`main push` 不做路径过滤，继续为确切发布 SHA 提供证据。不新增或修改分支保护。

CI 设置 `CARGO_INCREMENTAL=0`、`CARGO_PROFILE_DEV_DEBUG=0` 和 `CARGO_PROFILE_TEST_DEBUG=0`，保留默认调试断言和溢出检查；Rust 缓存仅由 main 更新。固定版本 npm 和 `npm ci` 使用 `--prefer-offline`，不改变锁文件约束或关闭依赖审计。同一 PR 有新提交时取消旧 CI；每个 `main push` 保留独立并发组，不因后续提交取消。不启用测试重试或全局放宽超时。

本地 `npm run check` 和 `npm run check:rust` 保持不变。复现 CI 的 TypeScript 范围使用 `npm run test:typescript`，不附加平台筛选参数。

格式、Lint、类型检查、TypeScript 和 Rust 保持独立 step。安装包 smoke 在依赖安装成功且任务未取消时，即使前面的检查失败仍会执行；先显式运行 `npm run build:typescript`，再复用当前 runner 构建和安装 macOS ARM64 npm 包，不掩盖前面失败的检查。

未来 `Release packages` 只构建 macOS ARM64 与 Intel 两套 DMG / npm 平台包，元包只声明这两个平台依赖。准备和发布 job 也使用 macOS runner。npm 元包生成和发布校验使用同一显式 `--targets macos-arm64,macos-x64`，缺失、重复或非预期产物仍会阻止发布；本地工具不传 `--targets` 时保留原来的全部平台默认值。这里只改变未来工作流，不创建标签、发布版本或移除既有产物。

旧标签仍包含其原来的工作流和打包脚本，不会被追溯修改。若从新 main 手动发布不支持 `--targets` 的旧标签，打包会拒绝未知参数；应核实并使用对应版本的恢复流程，不绕过产物完整性检查。

`release-packages.yml` 的发布校验继续保留，不属于 PR 评论功能：

1. 标签必须是合法 SemVer 的 annotated tag，正文包含 Release Notes；提交在 `main` 历史上。
2. `package.json`、`package-lock.json` 根版本及 Cargo workspace 版本必须与标签一致。
3. 默认等待确切发布 SHA 的主仓库 `main push` CI，最多 30 分钟，并要求 `Check macos-26` 基线 job 成功；CI 已失败则立即停止，不等待重试。
4. 构建和发布固定 commit SHA；发布前再次验证远端 tag object SHA、提交仍在 `main`，默认还校验绑定的 CI run ID / attempt 和结果。
5. 手动发布可显式启用 `skip_ci`，跳过准备阶段的 CI 等待和发布前的 CI 复验；默认关闭，Tag push 不能启用。该选择记录在 `release-evidence.json` 和 Actions Summary，并产生警告，不伪造 CI 成功证据。Tag、版本、Release Notes、提交归属、构建和产物校验仍执行。
6. 未明确跳过的校验失败就停止发布，不自动改版本或放宽条件；维护者核实后手动重新准备发布。

从默认分支手动运行 `Release packages`，指定已有 annotated tag：`skip_ci=false`（默认）等待并校验 CI，`skip_ci=true` 不查询 CI，即使 CI 缺失、运行中、失败或仅有手动单平台结果，也可继续构建发布。后者不代表通过 CI。此选项可与 `github_prerelease`、`skip_npm` 组合，重启发布时需重新明确选择。新 Tag 推送仍自动触发默认门禁；若要让新 Tag 只走手动发布，须经维护者授权临时禁用发布工作流后推送 Tag、恢复工作流，再手动运行，不靠推送后取消规避竞态。

如需让用户手动获取新版、但不向现有安装推送更新提示，可从默认分支手动运行 `Release packages`，指定原 annotated tag 并启用 `github_prerelease`。此选项只将新建的 GitHub Release 标记为 Prerelease 且不设为 latest；npm dist-tag 仍由版本决定，稳定 SemVer 发布到 `latest`。现有更新检查只读取 GitHub 正式 latest Release，因此不会提示这个预览发行。它不修改已有 Release 的状态，也不移动标签；默认要求确切标签提交的 CI 成功，显式选择 `skip_ci` 时例外。

npm 发布受阻时，可从默认分支手动运行 `Release packages`，指定原 annotated tag 并启用 `skip_npm`。该模式跳过 npm 发布，仍从标签的固定提交构建安装包，保留全部版本和 Tag 校验，默认保留确切提交 CI 校验（显式选择 `skip_ci` 时例外），通过后只发布 GitHub Release。无需移动或重建标签；默认发布仍要求 npm 发布成功。

标签推送使用标签提交里的工作流定义，新校验不会追溯改写旧标签的发布逻辑。这不是不可绕过的权限控制；未设置分支、标签或发布环境保护。

## 验证

```bash
npm run test --workspace=@codexhost/repository-automation
```

定向测试覆盖标题与标签所有权、CI 完整性、等待/失败/恢复、日志提取与脱敏、分页、只读预览、过期快照和发布校验。真实 Actions 写入测试需部署到可信分支并明确启用后执行。
