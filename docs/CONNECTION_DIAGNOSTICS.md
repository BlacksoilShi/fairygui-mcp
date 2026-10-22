# 原版连接诊断

新增工具 bridge_diagnostics 不接收参数，只读取当前配置的原版执行层。诊断不启动/停止进程、不安装插件、不保存工程，不探测source后端。

## 返回

- configuration：显式工程、loopback端点、编辑器文件存在性、最多两个工程文件计数。
- plugin：三个公共插件文件与当前候选的SHA256对比，以及私有配置是否一致；不返回令牌或其hash。
- owner：只检查已记录PID及出生时间、映像路径和工程身份，不扫描其他进程。
- connection：connected、endpoint_unreachable、timeout、authentication_rejected、redirect_rejected、project_identity、session_identity、request_identity、stale_heartbeat、not_ready、response_limit、invalid_response等。
- recommendedActions：建议检查或显式启动的动作标签，不自动执行。
- ready：只说明实时ping握手就绪，不证明所有写入、保存和发布功能通过。

有记录PID停止且端点不通，与PID仍匹配但端点异常会给出不同建议。没有owner记录时不推断所有编辑器都未运行。插件不一致与连接就绪可以同时存在，分别显示。

默认2秒HTTP预算、64KiB响应、每个插件文件4MiB、工程文件计数最多2；私有状态通过现有有界JSON读取器解析。重定向和代理禁用。诊断不是操作系统沙箱。

## 测试与目录变化

新增36项Python负例/身份/无副作用测试，以及真实stdio→Python helper→loopback HTTP的测试。原版在线检查另存项目验收目录，不用fixture代替原版证据。

增加一个工具：无source模式35、source模式39、source上传模式40。旧测试只有三个目录断言字面量迁移（34→35、38→39、精确名字表增加bridge_diagnostics）；其他原断言保留。完整回归必须重新运行。

此功能随0.7.0分发。当前客户端是否加载以重新连接后的 tools/list 为准；目录存在不代表正在运行此版本。原版插件保持0.6.0字节一致。
