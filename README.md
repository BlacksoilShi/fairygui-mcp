> 0.6.0 候选：通用独立后端、显式声音上传、分支发布及经双版本验证的中断恢复。
> 服务端、helper、工程插件需成对更新。本候选未自动升级本机部署；范围与验证见 [0.6.0](docs/RELEASE_060.md)。

# FairyGUI MCP

通过工程插件和原版编辑器 API 操作 FairyGUI 的独立 MCP 工具。
基于 [wingcd/fairygui-agent-bridge](https://github.com/wingcd/fairygui-agent-bridge)
的 MIT 源码改造；保留原许可，见 [UPSTREAM.md](UPSTREAM.md)。

**这不是 FairyGUI 编辑器源码，也不包含编辑器程序、SDK、用户工程、反编译产物或访问令牌。**
无需修改编辑器二进制。原版 GUI 进程需要运行；不是 headless 编辑器。

## 架构与范围

```text
MCP client → Node stdio server → authenticated 127.0.0.1 HTTP
                                      ↓
                              project-local JS plugin
                                      ↓
                              original editor API

Optional source_* tools → explicitly configured external Python backend
```

- 本版本默认 **34 个工具**：读取工程/组件、创建组件、插入/删除对象、改属性、保存、发布、日志、启动等。
- 配置独立重建后端后增加 4 个 `source_*` 工具，共 **38 个**；通用模式另行显式启用声音上传后为 **39 个**。重建后端不在本仓库中，不是默认运行依赖。
- 原生编辑和离线重建是两套执行层，工具说明中明确区分。
- 已在 **Windows / FairyGUI Editor 6.1.4、6.0.5** 验证部分原生功能；逐项范围见 docs/NEXT.md，不是全部 API 的兼容性保证。
- `refresh` 已验证外部资源导入；导入异步完成，应轮询读取。`screenshot` 已验证原生 UI 内容截图与独立 PNG 文件检查。
- 发布验证检查原生成功状态、对应包文件的新近时间、FGUI 文件头、包 ID、大小和 SHA256。
  **不声称已解码所有字段、渲染一致或与 GUI 发布逐字节相等。**
  当前验证器支持常见 `<发布包名>.bytes` / `<发布包名>_fui.bytes` / `<发布包名>.fui`；自定义发布命名和格式需增加适配。

## 安装

依赖：Node.js 22+、Python 3.11+、已安装的 FairyGUI 编辑器。全部运行依赖来自标准库，无需 npm/pip 安装第三方包。

先使用工程副本试运行。将仓库、工程和私有运行目录分别放置，例如：

```text
D:/FGUI-work/fairygui-mcp/   # 本仓库
D:/FGUI-work/project/       # 你自己的工程，含一个 .fairy
D:/FGUI-work/runtime/       # 私有 config.json、进程状态和日志
```

PowerShell 示例（替换为自己的绝对路径）：

```powershell
git clone https://github.com/BlacksoilShi/fairygui-mcp.git D:/FGUI-work/fairygui-mcp
python D:/FGUI-work/fairygui-mcp/setup.py `
  --project D:/FGUI-work/project `
  --editor D:/Apps/FairyGUI-Editor/FairyGUI-Editor.exe `
  --runtime D:/FGUI-work/runtime --port 17931
```

setup 生成随机令牌，不输出令牌、不覆盖已有配置、不修改工程。
默认发布目录和截图目录是工程的同级目录；端口支持 1024–65535。

在任意支持 stdio 的 MCP 客户端中添加：

```json
{
  "mcpServers": {
    "fgui": {
      "command": "node",
      "args": [
        "D:/FGUI-work/fairygui-mcp/server.mjs",
        "--config", "D:/FGUI-work/runtime/config.json"
      ]
    }
  }
}
```

配置中的 `python` 默认使用执行 setup 的解释器绝对路径。客户端找不到 Node 时，`command` 也使用绝对路径。
原生工具调用超时建议至少 **150 秒**；原生发布最多 120 秒，另留产物核验时间。通用后端设为最大 HTTP 超时时，客户端应至少留 **260 秒**；详见后端协议。

### 第一次使用

1. 调用 `editor_start`：安装工程插件并启动编辑器，或连接已经匹配的运行实例。
2. `ping` → `project_info` → `list_packages` → `read_component`。
3. 使用已确认的对象/资源名进行修改，再 `save_all` / `publish`。

已有插件文件与当前版本不一致时会报 `PLUGIN_CONFLICT`，不会静默覆盖。
先关闭对应编辑器、备份该工程的 `plugins/fgui-agent-bridge-custom`，再明确更新插件。
外部已经打开相同工程但未加载插件时，应先关闭它再启动，避免同工程多实例写入。
`editor_start` 不扫描或关闭无关进程，也不会自动重试失败的启动。

## 可选的独立重建后端

在私有配置中增加两个绝对路径：

```json
{
  "sourceHelper": "D:/your-rebuild/helper.py",
  "sourceConfig": "D:/your-rebuild/config.json"
}
```

这是配置片段，不是完整配置。两个字段同时配置才启用四个 `source_*` 工具。
后端应使用同一个配置的 Python 解释器，接受 `helper.py COMMAND JSON_ARGS`，
从 `FGUI_MCP_CONFIG` 读取配置，stdout 仅返回 `{"ok":true,"result":...}` 或错误 JSON。
当前兼容适配约定为固定 `Gesture/Main`，属性对象 `n0/n1`，同次调用内 undo/redo；
并非任意工程通用重建器。调用该后端就是执行本地 Python 代码，仅配置可信文件。


### 通用重建后端（显式选择）
上面的配置保留旧版固定 Gesture/Main 适配。需要任意工程/组件选择时，在同一私有配置中另加
`"sourceProtocol": "fgui-rebuild-http/1"`。此时四个固定工具被四个通用工具替换，
不是叠加：`source_capabilities`、`source_state`、`source_command`、
`source_receipt_read`，仍为 38 个工具。后端需单独安装并已启动；本仓库只分发客户端。

再显式设置 `"sourceUploads": true` 且后端配置导入根目录，才增加
`source_sound_upload`（共 39 个）。上传不是原版编辑器导入，也不是音频解码验证。
大结果通过有界快照或持久回执分页，调用方需按实际 nextOffset 拼接并核对 SHA256。
迁移预览的短期 planToken 可通过 MCP 传回；它不是身份认证令牌，过期或历史回执不续期。

配置、尺寸限制、去重/未知结果语义见 [通用后端协议](docs/SOURCE_BACKEND.md)、
[上传约定](docs/SOUND_UPLOAD.md) 与 [迁移租约](docs/MIGRATION_PLAN_LEASES.md)。
原生 session/revision 与独立后端 session/revision 分开，交叉使用无效。

## 原生发布与中断恢复
`publish` 支持 configured/all/selected/trunk 模式。selected 要求非空 branch；all/trunk 不接受 branch。
configured 仅在当前配置采用单分支处理时接受 branch，全分支配置会明确报错而非忽略参数。
只处理当前配置工程；source_* 与原生发布是两套执行层。详见 [发布范围](docs/RELEASE_060.md)。

仅在明确处理此前中断的原生发布时调用 `editor_start({"recoverPublish":true})`。
普通启动行为不变。外部 Windows helper 核验旧进程身份并签发短期证明，原生插件完成
设置落盘回读和匹配记录清理后才报告恢复。存活/身份不明、磁盘冲突或清理失败仍保持阻塞。
不要手工删租约或按锁文件年龄猜测进程已退出。见 [恢复协议](docs/PUBLISH_OWNER_PROOF.md)。

## 测试

```powershell
cd D:/FGUI-work/fairygui-mcp
npm test
python tests/test_helper.py
python tests/test_publish_owner.py
python tests/test_recovery_helper.py
```

测试创建本地临时文件与 loopback mock 服务，不启动原版编辑器、不需要 GitHub 凭据。
Windows CI 执行相同测试。插件主文件由九个源码片段拼接生成：

```powershell
npm run build:plugin
```

`scripts/build-plugin.mjs --check` 检查生成文件是否与源码一致。
测试层次与发布范围见 [docs/REVIEW.md](docs/REVIEW.md)。

## 使用边界

- 一个 server 对应一个显式配置的工程；多个工程使用不同端口和配置。
- loopback、Bearer、Host/Origin 检查、session/request ID 和截止时间。
- 输入在换行前即有 64 KiB 内存上限；HTTP 响应、编辑队列和并发请求同样有界。
- 尚未调度的请求可取消；已经发送给编辑器的操作可能已产生作用，超时/断连不等于撤销。
- 原生写操作不自动重试；原生去重在内存中，不是持久事务。通用后端另有持久回执与未知结果规则。
- 不暴露任意执行脚本、任意 HTTP 目标或全局工程自动发现。
- 私有配置中含令牌；工程插件内也有相应配置。工程对外发布时同样需要排除它。
- 路径约束不是同用户恶意代码的系统沙箱，也不消除文件系统竞态。
- 原生运行可产生 FairyGUI 自身的用户配置/缓存；本仓库不是操作系统级隔离器。

## 回退

停用客户端 MCP 条目即停止新请求，不会自动关闭编辑器。
代码更新使用 Git 提交管理，回退到已验证提交后重新加载客户端。
更新插件前保存备份；退出对应编辑器后恢复旧插件，再启动。
原版编辑器二进制不在本仓库中，也不由本工具修补。
