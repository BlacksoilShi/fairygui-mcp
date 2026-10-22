# 只读操作参数模式查询

显式配置sourceProtocol为fgui-rebuild-http/1，并设置sourceSchemas:true，才新增source_operation_schema工具。sourceHelper必须指向配套支持该命令的外部适配器；后端仍独立分发，不包含在公开MCP客户端运行依赖中。

参数：operation单项，或者offset/limit列表；两类互斥。limit1..10，offset0..256；offset>0需匹配schemaDigest。参数额外字段、非法操作名、坏摘要在查询前拒绝。

适配器先读元数据核对工程及独立执行层，再读固定/api/operation-schema路由；不接受任意URL。检查相同session、广告摘要、操作顺序、条目数量、分页进展及覆盖标记。48KiB HTTP模式响应、60KiB helper及64KiB最终MCP帧分别检查。总量未知或响应超限不会静默截断。

source_operation_schema只读取，不生成requestId，不消耗写命令回执/快照容量，不执行原版编辑器。metadata预检与查询之间revision可变化，因为模式与源编辑revision独立；session变化则拒绝。它仍是两个只读GET，不宣称跨请求源事务。

模式描述中的properties.planToken等字段名保留，不当成真实凭据删除；结构外的敏感键继续脱敏。若返回值包含适配器或MCP已配置的真实凭据，拒绝整份结果而非悄悄改模式。客户端保留模式原结构，避免破坏发现语义。

当前参数基础只有80项顶层结构和10项结构类型模式，70项嵌套值、条件/场景语义、结果模式仍待补；complete:false原样传递。本工具接入不把这些剩余工作标记完成。

## 目录和升级

原诊断候选默认35、generic source39、显式上传40工具。schema再增加1项：generic source+schema40，generic source+schema+上传41。sourceSchemas缺省或false保持原目录与旧配置。随0.7.0分发；实际目录仍取决于私有配置与客户端重新连接。

回退先恢复旧代码配套的私有配置，移除sourceSchemas新字段；旧代码不接受该新增键，即使false。代码回滚不自动编辑私有配置。

## 验证

既有测试全部保留；新配置测试、适配器负例、真实stdio→外部helper→实际HTTP模式模型、关闭开关、旧后端、错误工程及超限/凭据故障注入分别验收。仅normal阶段是未篡改实际HTTP链路，故障注入单独标注。

测试使用公共工具库Python/Node，客户端新增独立测试无需编辑器或重构后端。完整链路在项目验收脚本中运行，私有配置与令牌不进入发布包。
