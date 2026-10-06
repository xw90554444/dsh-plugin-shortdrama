# 短剧工作室 · ShortDrama Studio

DSH 插件：把「剧本 → 人物/场景 → 分镜头 → 关键帧 → 提示词 → 出片」整条竖屏短剧流水线搬进 Harness，
全部算力走**你本机的 ComfyUI**，不依赖任何云服务。

**P0–P5 全部实现。**

---

## 它能做什么

一条命令式的流水线，每一步都可以单独跑、单独重跑：

```
drama_project  →  drama_script  →  drama_cast  →  drama_storyboard  →  drama_render  →  drama_prompt
   建项目          出剧本          抽人物场景      拆分镜头            出图 / 出片        编译提示词
```

或者打开侧边栏的**短剧工作室**面板，在图形界面里点完。

---

## 已实现能力

### P0 · 打通本机 ComfyUI

- Host 侧客户端：`/system_stats`、`/object_info`、`/prompt`、`/history`、`/view`、`/upload/image`、`/queue`、`/interrupt`、WebSocket 进度
- 设置页连接测试：版本 / GPU / 显存 / 内存 / 延迟 + 资源容量评估
- 模型绑定下拉，选项直接来自 `/object_info`，不可能拼错文件名
- **提交前校验**：逐节点检查 class 是否存在、枚举值是否为已安装模型，把"排进队列才炸"提前到提交前
- **本机推荐模型档**：把"哪种权重适合哪种用途"编码成规则（`_pruned_` 优先、REF2VA 保身份、turbo LoRA 加速）

### P1 · 提示词引擎

- `lib/pipeline/compile.js` —— **纯函数编译器**，无 I/O、无时钟、无随机，可单测
- H3 提示词按官方模板的时间轴格式输出：`风格总述` + `Timeline:` 分段 + 独立 `Audio:` 段 + 负向约束
- 中英景别/机位/运动归一化，保证同一分镜两次编译得到同一个字符串
- 帧网格换算：`length` 自动吸附 MiniMax-H3 的 17k+5 网格（5s→124、3s→73、10s→243）
- 分辨率预设：9:16 竖屏 768×1344 / 16:9 1344×768，全部 32 的倍数、长边封顶 1344

### P2 · 剧本与分镜头生成

- 三段 LLM 流水线，共用 `ctx.llm`，默认跟随你的会话模型（可在设置页覆盖）
- **结构化输出可靠性**：模型回复经 `提取 → 校验 → 失败回灌重试`，只有满足声明形状的对象才会被采用
  - 能救回裸 JSON、```json 围栏、夹在解释文字里的 JSON；括号在字符串内也不会误判
  - 数字以字符串给出（`"3"`）会被接受，不浪费一次重试
- **分镜头双重关卡**：形状校验通过后，还要过一遍渲染器真正会用的 lint；有硬错误就带着具体问题重写一次
- **自动修复**：越界时长被夹紧、未知场景/角色引用被丢弃并报告、说话人不在演员表会被指出
- **lockToken 卫生**：一致性锚点里若混入"微笑""特写"这类瞬时状态，会被识别并从不变特征重建——否则它自己就破坏了跨镜头一致性

### P3 · 出图

- 人物与场景**参考图**：一次生成，重roll 可控 seed
- 每镜**关键帧**：两种模式
  - `i2i`（默认自动）：该镜只涉及一个角色且该角色有参考图时，以参考图做图生图（denoise 0.55），足够自由地构图，又足够克制地保住脸
  - `t2i`：多角色镜头退回文生图——可靠地融合两张参考图是另一个问题，这一阶段不假装能解决
- 产出的图片直接落盘并在 UI 内预览

### P4 · 出片（MiniMax-H3，含原生音频）

两种 H3 通路，设置页可切换：

**FL2VA · 首尾帧生视频**（默认，最省显存）
```
UNETLoader → [turbo LoRA] → BasicGuider + BasicScheduler
CLIPLoader → MiniMaxH3ImageToVideo → BasicGuider
MiniMaxH3ImageToVideo → LATENT → SamplerCustomAdvanced
SamplerCustomAdvanced → VAEDecode(视频) 与 VAEDecodeAudio(音频)
CreateVideo(images, audio) → SaveVideo
```

**REF2VA · 参考图生视频**（身份最稳，适合角色反复出现）
```
CLIPLoader + 视频VAE + 音频VAE + N 张参考图 → MiniMaxH3ReferenceToVideo
                                            → CONDITIONING → BasicGuider
                                            → LATENT → SamplerCustomAdvanced
```
- 用的是**另一个节点** `MiniMaxH3ReferenceToVideo`，不是 FL2VA 那个
- 参考图是 `COMFY_AUTOGROW_V3` 分组输入，API 格式用点号键 `ref_images.ref_image_0..8`（上限 9 张）
- 参考图会**参与每一步采样**，所以 `ref_image_size` 提供两档：
  - `match` — 按生成画幅缩放，快
  - `max` — 使用 2048px 短边，身份还原最好，但慢数倍
- 没有可用参考图时自动回退到 FL2VA 并提示

**两者共通**：
- **不需要手工导出工作流**：图由程序构建，每个节点类、入参名、枚举值都从实时 `/object_info` 读出
- H3 的音画是同一次前向生成的，所以音频 VAE 从同一个 latent 解出后直接封装进容器
- **分段续接**：超过 15 秒自动切段；每段的首帧用它自己第一个镜头的关键帧，不需要解码上一段视频抽帧
- 长任务进队列，可离开页面、可中止、可单出某一段

### P5 · 导出与回退

导出制作包（`$DSH_HOME/shortdrama/exports/<项目>/`）：

| 文件 | 内容 |
|---|---|
| `script.md` | 剧名、梗概、分场对白、人物与场景设定表（含一致性锚点） |
| `h3-prompts.md` | 每个可渲染片段的完整 H3 提示词 |
| `shot-list.csv` | 分镜表（带 BOM，Excel 直接打开不乱码） |
| `shot-list.json` | 结构化分镜与片段信息 |
| `prompts.json` | 完整编译结果（含每镜关键帧提示词） |
| `cloud-requests.json` | 走 MiniMax 云 API 的请求体，一个片段一条 |

---

## 安装

```bash
dsh plugin --profile desktop add <本目录>
```

> **注意**：宿主半边是 Node ESM 模块，**改动后需要重启 DSH 才能生效**。
> disable/enable 不够——Node 的模块缓存会保留旧代码。
> 客户端半边每次刷新页面重新加载，改完刷新即可。

---

## Agent 工具

| 工具 | 作用 |
|---|---|
| `drama_project` | 建/查/改/删项目 |
| `drama_script` | 生成或按指令重写剧本 |
| `drama_cast` | 抽取人物与场景设定；可选顺带出参考图 |
| `drama_storyboard` | 拆解分镜头（自动过 lint 并重写） |
| `drama_prompt` | 编译双提示词；可导出制作包 |
| `drama_render` | 出参考图 / 出关键帧 / 出片；查队列、中止、看资源 |
| `drama_comfy` | ComfyUI 诊断、自动选型结果、生成模型 |

长任务（生成、出图、出片）都是**可轮询的运行**：工具等一小段就返回 run id，用
`drama_render action=status runId=...` 继续查，不会把一个回合卡在一次渲染上。

---

## 数据位置

```
$DSH_HOME/shortdrama/
├── config.json                    # 地址、模式、预设、模型绑定、生成模型
├── projects/<id>.json             # 每个项目一份可 diff、可手改的文档
├── assets/<projectId>/<id>.<ext>  # 生成的图片与视频
└── exports/<项目>/                # 制作包
```

---

## 实测过程中发现并修掉的问题

这些都不是设计阶段能想到的，是跑真机测试逼出来的：

| # | 问题 | 后果 |
|---|---|---|
| 1 | **片段帧数按各镜头分别吸附后相加** | H3 节点对整个片段只接受一个 `length`。3s+2s+4s → 73+56+107 = **236**，而 236 % 17 = 15，**不在网格上**，提交会被拒。正确值是 `snapFrames(9) = 226` |
| 2 | **LoRA 匹配不到时回退到"已安装的第一个"** | 会把一个 Wan Animate LoRA 静默套到 Qwen-Image 上。LoRA 天生可选，匹配不到就该是"不加" |
| 3 | **上传参考图后 `object_info` 缓存未失效** | `LoadImage.image` 是输入目录的枚举，缓存里没有刚上传的文件 → 校验会拒绝一个合法工作流，**每一次图生图和首帧出片都会断** |
| 4 | **分辨率长边封顶算法错误** | 16:9 被压成 1344×736 而不是官方的 1344×768——等比缩放两边会同时缩掉短边，应从封顶的长边反推短边 |
| 5 | **中文标题生成的项目自己读不出来** | id 要进文件名和 URL，必须 ASCII 安全；改为 djb2 哈希兜底，两个不同中文标题得到不同 id |
| 6 | **引导器误判为 CFGGuider** | 官方模板用的是 `BasicGuider`（无 CFG、无负向条件）。从模板里读出真值后修正 |
| 7 | **REF2VA 模式是空头支票** | 设置页提供了 REF2VA 选项，但构图器只建 FL2VA 的图——拿 ref2va 的权重去跑 `MiniMaxH3ImageToVideo`。实际上 REF2VA 用的是另一个节点 `MiniMaxH3ReferenceToVideo`，参考图还是 `COMFY_AUTOGROW_V3` 分组输入（点号键、上限 9 张）。已实现并真机跑通 |
| 8 | **`Cannot access 'reasoning' before initialization`** | 进度回调引用了**同一次解构正在初始化**的 `reasoning` 常量。`collectStream` 期间回调被调用时，该绑定还在暂时性死区里——于是**每一个真实运行**都在第一个流式分片上必崩，`drama_script` 全线不可用。阴险之处在于：所有早期测试都直接调流水线且**从不传 `onProgress`**，恰好绕开了这条路径。已修，并新增 `verify-api-p2.mjs` 专测真实 api 入口 |
| 9 | **"没有可用模型"被当成服务器故障** | `startScriptRun` / `startCastRun` / `startStoryboardRun` 里的 `llmDeps()` 会抛出，而它在 run 包装之外——于是 Web 路由返回 500，而不是和别处一致的 `{ok:false, error:{code:'no-model'}}`。这是用户可自行修复的普通状态，不该表现为故障 |
| 10 | **整个 Web 半边会随机不注册（最隐蔽）** | 在 `apply()` 里用 `ctx.get('webServer')` 判断——但 `ctx.get` **不等待**，提供者此刻未就绪就返回 undefined，于是插件静默跳过路由与令牌注入。结果是**工具能用、界面全死**，日志里什么都没有。而且它是**间歇性的**：第一次重启恰好就绪（路由返回 403），第二次没就绪（404）。已改为把 Web 半边拆成声明 `inject: ['webServer']` 的**子插件**：无载体时保持 PENDING（工具照常可用），有载体时正确等待 |
| 11 | **空项目列表时所有错误都被吞掉** | 错误提示只渲染在「有项目」分支，`projectsState.error` 更是从未渲染过。而"一个项目都没有"恰恰是新用户最容易遇到失败的状态——于是面板看起来完全没反应，点哪都没动静。已改为两种分支都渲染消息区 |
| 12 | **出图全糊**（用户实测反馈） | 三处错误叠加：① 用通用 `CLIPTextEncode` 而非专用 **`TextEncodeQwenImage21`**；② **把提示词增强器（`*_pe_*`）当成了主文本编码器**——它是另一个模型，不负责给扩散模型做条件；③ 只跑 8 步还挂着 4 步蒸馏 LoRA。修正后同一提示词 **21.7 秒**出图（原来 371 秒），细节清晰 |
| 13 | **校验器误报自动增长输入** | `COMFY_AUTOGROW_V3` 类型的输入在 `input.required` 里但 `min:0`（允许为空），校验器把它当成"必填未设置"，导致**任何用到自动增长输入的节点都被误判**。其子槽是点号键（`images.image_1`），也须算作已填 |
| 14 | **模块之间没有流程感**（用户实测反馈） | ① 在「人物场景」点出参考图会**直接跳到「出图出片」页**，读起来像模块互不相关——改为不跳转、进度就地显示；② 五个页签是扁平平级的，没有先后感——改成**步骤条**，显示每步完成状态、把第一个未完成的标为「下一步」、正在跑的显示转圈；③ 新增由项目状态推导的「下一步该做什么」 |

---

## 已知限制与实测性能

**实测数据（RTX 4070 Ti SUPER 16 GB，本机 ComfyUI 0.38.2）**：

| 操作 | 耗时 | 产物 |
|---|---|---|
| 单张参考图（Qwen-Image 2.1 int8，4 步 + turbo） | **371 秒**（首次，含模型冷加载） | 1.5 MB PNG 768×768 |
| 单张关键帧（图生图，denoise 0.55） | 模型已加载后明显更快 | PNG |
| FL2VA 出片 5.17 秒（turbo LoRA，6 步，768×1344） | **228 秒** | 594 KB MP4，含音轨 |
| REF2VA 出片 3.04 秒（参考图 2 张，`match`） | **137 秒** | 767 KB MP4，含音轨 |

- **首次出图很慢**，大部分时间花在模型冷加载上；同一模型连续使用会快很多。
- **H3 出片需要充裕内存**：权重约 19.5 GB，16 GB 显存会分块卸载到内存（实测峰值时显存仅剩 0.75 GB、内存剩 5.9 GB）。设置页的资源徽标会在内存不足时标红。
- **角色一致性仍是难题**：参考图 + lockToken + 图生图三重手段，但跨镜头漂移仍会出现，重要镜头建议固定 seed 重roll。你本机装了 `SS_FaceSwap_MiniMax_H3_REF2VA`，配合 REF2VA 模式是本地最强的一致性手段。
- **H3 原生音频不可精确控口型**：中文字幕建议后期单独配音，提示词里用 `Audio:` 段描述氛围音与音效。
- **多角色同框的关键帧**：当前退回 t2i。要真正做多参考图融合，需要接入 Qwen-Image-Edit 一类的编辑节点。
- 生成质量取决于所选模型；`deepseek-flash` 能出结构合规的分镜，但编剧水准请以实际产出为准。

---

## 验证

五套离线/在线测试，共 **334 项检查**（`node .verify/verify-*.mjs`）：

| 套件 | 覆盖 | 检查数 |
|---|---|---|
| `verify.mjs` | 提示词编译器 + ComfyUI 契约（对着真实 `127.0.0.1:8188`） | 68 |
| `verify-prompts.mjs` | P2 提示词/规格契约 + 三阶段流水线（合成模型，离线） | 46 |
| `verify-host.mjs` | 宿主端到端：配置、项目、编译、导出、错误路径、**插件装配契约** | 84 |
| `verify-api-p2.mjs` | **P2 走真实 api 入口**（`startScriptRun` / `startCastRun` / `startStoryboardRun`，带 `onProgress`） | 29 |
| `verify-p2p5.mjs` | P2–P5，含 Qwen-Image 2.1 图像通路与 FL2VA / REF2VA 两条出片通路的真实验证 | 107 |

`verify-p2p5.mjs` 默认跳过渲染。按需开启：

```bash
RENDER_IMAGES=1    # 真实出参考图（数分钟）
RENDER_KEYFRAME=1  # 真实出关键帧（图生图）
RENDER_VIDEO=1     # 真实 FL2VA 出片（约 4 分钟）
RENDER_REF2VA=1    # 真实 REF2VA 出片（约 2.5 分钟）
```

ComfyUI 未运行时，依赖它的检查会明确标记为 SKIPPED，而不是报一堆红。

`verify-api-p2.mjs` 的存在本身是个教训：它专测**真实 api 入口 + 带进度回调**这条路径，因为缺陷 #8 恰恰藏在那里——
所有直接调用流水线的测试都绕开了它。

已验证的真机产物：FL2VA 594 KB MP4（含 `mp4a` 音轨）、REF2VA 767 KB MP4（含音轨）、1.5 MB PNG 参考图、图生图关键帧。
