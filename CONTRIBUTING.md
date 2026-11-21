# 协作开发说明

## 本地启动

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

打开 `http://127.0.0.1:4173`，按 README 的演示路径检查四步流程。

## 变更约定

- 页面交互在 `app.js`，音频和账本分别由 `audio.js` 与 `registry.js` 处理，样式在 `styles.css`。
- 不要提交真实音频、授权材料、私钥、RPC 密钥或 `.env` 文件。
- 合约和链上适配器的接口一起更新。请使用单独的测试网合约做联调。
- 提交前运行 `node --check app.js`、`node --check audio.js`、`node --check registry.js`，并在浏览器走一次完整验收链路。

## 分支建议

从 `main` 创建功能分支，例如 `feat/contract-adapter`，通过 Pull Request 合并。
