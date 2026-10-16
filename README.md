# Cloudreve Drive Skill (v4)

Cloudreve v4 REST API 客户端与 Agent CLI 工具。通过 OAuth 2.0 授权码模式（含 PKCE）安全接入 Cloudreve 个人网盘，支持端到端的文件增删查改、目录创建、直链生成、以及大文件分片/S3 预签名直传回调。

> **详细使用指南、指令参数及配置规范请参阅 [`SKILL.md`](./SKILL.md)。**

---

## 目录结构

```text
.
├── SKILL.md            # Skill 核心文档与 Agent 调用手册
├── README.md           # 本说明文件
├── config.json         # Skill 结构化配置文件
├── .env.example        # 环境变量配置模板（请勿提交真实凭据）
├── package.json        # 项目依赖与构建脚本
└── source/             # TypeScript 纯源码工程
    ├── index.ts        # CLI 交互入口
    └── src/
        ├── client.ts   # Cloudreve v4 REST API / OAuth PKCE 核心客户端
        └── config.ts   # 配置加载与环境变量解析模块
```

---

## 环境准备与依赖

本项目基于 **Bun** 运行时构建与执行。

- **Bun** >= 1.0.0
- **Cloudreve** >= v4.0.0（需要管理员在管理面板注册一个 OAuth 应用）

安装依赖（可选，用于类型检查）：
```bash
bun install
```

---

## 配置说明

1. 复制 `.env.example` 为 `.env`：
   ```bash
   cp .env.example .env
   ```
2. 在 `.env` 中填入你的 Cloudreve 实例地址及 OAuth 凭据：
   ```env
   CLOUDREVE_BASE_URL=https://drive.your-domain.com
   CLOUDREVE_CLIENT_ID=your_client_id
   CLOUDREVE_CLIENT_SECRET=your_client_secret
   ```
> ⚠️ **注意**：`.env`、`token.json` 和 `login-pending.json` 包含私密授权凭证，严禁提交到公开代码仓库！

---

## 编译指南

本项目遵循单文件产物打包标准。编译源码生成 `app.js`：

```bash
bun run build
# 或者直接执行 bun 原生构建命令：
bun build source/index.ts --outfile app.js --target node
```

编译完成后根目录下会生成可独立运行的 `app.js`。

---

## 快速上手

### 1. 登录与授权 (OAuth PKCE)
```bash
# 生成并打印授权链接
bun app.js login

# 浏览器访问授权链接后，将回调 URL 附带的 code 回填：
bun app.js login-finish --code "http://localhost:6689/?code=xxx&state=yyy"

# 检查当前授权状态
bun app.js status
```

### 2. 常用文件操作
```bash
# 列出根目录
bun app.js ls /

# 创建目录
bun app.js mkdir /documents

# 上传文件（支持预签名分片及直传）
bun app.js upload --local ./local_file.pdf --remote /documents/file.pdf

# 下载文件
bun app.js download --remote /documents/file.pdf --local ./downloaded.pdf
```

更多高级用法与参数选项请直接查看 [`SKILL.md`](./SKILL.md)。
