# Bookmark Nav Sync

把 Chrome / Edge 的书签实时捕获、加密后同步到 GitHub，再由 GitHub Pages 提供一个可搜索的个人导航页。

> **隐私模型**：仓库可以是公开仓库，但 `data/bookmarks.enc.json` 只保存 AES-GCM 密文。网页在浏览器本地解密，GitHub、Pages、任何 CDN 都看不到明文书签。

## 功能

- 监听书签创建、删除、重命名、移动、排序和导入完成事件
- 15 秒防抖：连续编辑或批量导入只提交一次
- MV3 service worker 被回收后，使用 `storage.session` / `alarms` 保留待同步状态
- 断网自动重试；GitHub 并发写入冲突时刷新 SHA 后重试一次
- 全量快照而非增量 diff：实现简单、幂等，适合个人书签树
- PBKDF2-SHA256（600,000 iterations）派生 AES-256-GCM 加密密钥
- 导航页本地搜索标题、URL、域名、文件夹；响应式布局和暗色主题
- 默认不加载第三方 favicon 服务，避免把访问过的域名暴露给第三方
- 每次同步产生 Git commit，可以从 Git 历史恢复误删版本
- 提供明文 HTML 备份导出（请放在安全位置）

## 目录

```text
bookmark-nav/
├── extension/                  # Chrome / Edge Manifest V3 扩展
│   ├── background.js           # 事件、去抖、重试、同步状态
│   ├── lib/bookmarks.js        # getTree + 规范化 + HTML 备份
│   ├── lib/crypto.js           # WebCrypto PBKDF2 + AES-GCM
│   ├── lib/github.js           # GitHub Contents API
│   ├── options.html/.js/.css   # 配置页
│   └── popup.html/.js/.css     # 状态弹窗
├── web/                        # GitHub Pages 静态站源码
├── data/bookmarks.enc.json     # 加密快照；首次配置前是占位文件
├── .github/workflows/pages.yml # 自动部署 web + data
└── scripts/check.mjs           # 无依赖静态检查
```

## 从零部署

### 1. 创建 GitHub 仓库

建议创建一个**专用仓库**，不要把其他项目和书签放在一起。

1. 在 GitHub 新建仓库，例如 `my-bookmarks`。
2. 可以选择 Public。加密方案下，公开仓库不会直接暴露书签明文。
3. 把本目录的文件推送到仓库的 `main` 分支。
4. 在仓库 **Settings → Pages** 中选择 **GitHub Actions** 作为 Source。
5. 等待 `Deploy Bookmark Nav` workflow 成功。

Pages 地址通常是：

```text
https://<你的用户名>.github.io/<仓库名>/
```

如果仓库名是 `<你的用户名>.github.io`，地址则是根域名。

### 2. 创建最小权限 Fine-grained PAT

在 GitHub：头像 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**。

- Resource owner：选择你的账号
- Repository access：**Only select repositories**，只选书签仓库
- Repository permissions：
  - **Contents: Read and write**
- 其他权限保持 No access
- 设置合理的过期时间；建议定期轮换

创建后只在扩展设置页粘贴一次。Token 保存在浏览器扩展的本地存储中，**不会写入仓库、网页或日志**。

> 如果 Token 泄露，立即在 GitHub 撤销它并重新创建。不要把 Token 写入 `README`、截图、Issue 或 git commit。

### 3. 加载扩展

Chrome / Edge 地址栏打开：

- Chrome：`chrome://extensions`
- Edge：`edge://extensions`

打开右上角 **Developer mode / 开发者模式** → **Load unpacked / 加载已解压的扩展** → 选择本项目的 `extension/` 目录。

然后打开扩展的 **Options / 选项**：

1. 填写 GitHub Owner、Repository、Branch（一般是 `main`）
2. 粘贴 fine-grained PAT
3. 设置至少 12 个字符的加密口令，并再次确认
4. 点击 **测试 GitHub 连接**
5. 点击 **保存配置**
6. 点击 **立即全量同步**

首次同步成功后，`data/bookmarks.enc.json` 会被扩展提交到仓库，Pages 会自动重新部署。

## 访问和解锁网页

打开 Pages 地址，输入和扩展设置中完全相同的加密口令即可解锁。

- 明文只存在当前浏览器的内存中
- 点击右上角“锁定”可清除当前页面会话
- 页面刷新后通常需要重新输入口令
- 页面只请求同源的 `data/bookmarks.enc.json`，并追加时间戳绕过静态 CDN 的旧缓存

### 私密链接（可选）

当前页面保留了 `#k=` 片段的解锁协议，后续可以生成这种链接：

```text
https://<你的 Pages 地址>/?#k=<base64url 编码的口令>
```

URL fragment 不会发送给服务器，但会出现在浏览器历史、同步历史或截图里。对于高敏感书签，不建议把口令放进 URL；直接手动输入更安全。

## 本地预览

网页必须通过 HTTP 服务打开，不能直接双击 `web/index.html`，因为浏览器会阻止 `file://` 页面读取模块和 JSON。

在项目根目录运行：

```bash
python -m http.server 8080
```

然后访问：

```text
http://127.0.0.1:8080/web/
```

本地预览默认读取仓库中的占位文件，因此会显示“还没有首次同步”。要测试真实数据，需要把一个真实的加密快照复制到 `web/data/bookmarks.enc.json`（不要提交含真实书签的测试密文到公共仓库，除非你明确知道自己在做什么）。

## 开发检查

项目不依赖 npm 包，可以运行：

```bash
npm run check
```

检查内容：

- 核心 JavaScript 语法
- Manifest V3 和必需权限
- service worker 配置
- 占位密文格式

## 同步时序和“实时”边界

```text
书签变更
  → 浏览器事件
  → 最多等待 15 秒合并变更
  → 扩展读取完整书签树并加密
  → GitHub Contents API 提交一个 commit
  → GitHub Actions / Pages 部署
  → 页面刷新时读取最新密文
```

个人使用场景下通常是几十秒到几分钟可见，具体取决于 GitHub Actions 和 Pages 部署队列。它不是 WebSocket 推送，也不会主动刷新已经打开的网页；网页重新加载时会读取最新版本。

## 安全边界

### 加密保护了什么？

- GitHub 仓库中的书签标题、URL、文件夹结构
- Git commit 历史中的书签内容
- Pages 静态文件中的书签内容

### 加密没有保护什么？

- GitHub 仓库名称、提交时间、文件大小
- 你访问 Pages 的事实和 IP（由 GitHub Pages 的基础设施处理）
- 你在浏览器本地输入的口令
- 口令本身泄露后的内容
- 浏览器扩展本地存储被恶意软件读取后的 Token / 口令

### 口令丢失

AES-GCM 密文没有后门。口令丢失后无法从 GitHub 恢复明文。请在扩展设置页定期点击 **导出明文备份**，并将备份存放在加密磁盘或密码管理器中。

## 故障排查

### 测试连接提示 401 / Bad credentials

- Token 复制不完整或已过期
- Token 的 Resource owner 不是当前仓库所属账号
- Token 没有对目标仓库授权

重新创建一个只授予目标仓库 `Contents: Read and write` 的 token。

### 提示 403 / Resource not accessible by integration

检查 fine-grained token 的 Repository access 和 Contents 权限。不要用只读 token。

### 仓库里有密文，但 Pages 页面仍显示没有首次同步

- 确认文件路径正好是 `data/bookmarks.enc.json`
- 确认 workflow 已成功运行
- 等待 Pages 部署完成后强制刷新（Ctrl/Cmd + Shift + R）
- 确认 Pages 的 Source 是 GitHub Actions

### 改了书签却没有提交

- 打开扩展弹窗查看状态和错误
- 先点击“立即同步”区分事件监听问题和 GitHub 配置问题
- 检查扩展的 Service worker 控制台：扩展详情 → Inspect views → service worker
- 确认系统时间正常；PBKDF2 和 API 请求都依赖正常的浏览器环境

### 同一个书签被重复看到

这是浏览器书签树中不同文件夹下存在多个相同 URL 的正常结果。MVP 保留原始树结构，不做自动去重，避免误删用户数据。

## 已知限制和后续路线

- 当前是单向同步：浏览器 → GitHub → 网页；网页不能修改书签
- 当前全量快照适合个人书签规模；极大的数据集可能需要拆分多个加密文件或切换 Git Data API
- Chrome 和 Edge 共用一套 MV3 代码；Firefox 兼容层尚未加入
- Pages 是静态站点，不提供服务器端权限控制；隐私依赖客户端加密
- 未来可加入：Firefox 打包、拖拽/网页端编辑、加密分享链接管理、分片快照、冲突可视化

## 许可证

MIT。详见 [LICENSE](./LICENSE)。
