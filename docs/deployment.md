# 部署配置与私有文件

仓库中的 `wrangler.jsonc` 是通用示例：默认启用密码认证，不包含实际域名、Google 客户端、邮箱白名单或账户标识。请修改示例资源名称后再部署自己的实例。

## 首次部署

1. 按 [README](../README.md#部署到自己的-cloudflare-账户) 创建私有 R2 桶。
2. 修改 Worker 名称和桶名；需要自定义域名时，在 `routes` 添加自己的域名。
3. 选择密码、免认证或 Google 白名单模式，设置相应 Secret。
4. 执行 `npm run check`，然后 `npm run deploy`。

不要将真实密钥填入提交到 Git 的配置文件。Google 配置的示例及客户端创建步骤见 [Google OAuth 配置](google-oauth.md)。

## 保留私有生产配置

如需让源码持续保持脱敏，可将部署配置单独保存在被 Git 忽略的 `wrangler.production.jsonc`：

```powershell
Copy-Item wrangler.jsonc wrangler.production.jsonc
```

仅首次创建时复制；已有私有生产配置时不要覆盖。修改私有文件中的实际 Worker、R2、域名、Google 客户端和白名单。Secret 仍由 Cloudflare Secret 管理；本地 `.dev.vars.production` 和 `.dev.vars.google` 也在忽略列表内。

`public/privacy.html` 使用示例联系邮箱。首次上线前将其改成站点实际隐私说明；如果不希望提交真实联系方式，将定制版本保存在 `.private/privacy.html`，构建后复制到产物目录。

更新已有生产实例时，显式指定私有配置：

```powershell
npm run check
npm run build
Copy-Item .private/privacy.html dist/privacy.html
npx wrangler deploy --config wrangler.production.jsonc
```

需要更新 Secret 时同样指定配置，例如 `npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.production.jsonc`。普通部署保留已有 Secret；不要随意修改 `APP_SECRET`、R2 桶或 Durable Object 绑定，否则已有接收码和数据可能无法正常访问。

真实部署记录可存放在 `.private/`，不提交到 Git。默认 `npm run deploy` 使用公开示例配置，不会自动读取 `wrangler.production.jsonc`。

## 用量与验证

站点额度的配置与限制见 [用量保护](../README.md#站点用量保护)。额度仅控制当前应用，预算提醒只负责通知，不是整个账户的停费开关。部署后按 [验证记录](validation.md) 检查 HTTPS、上传认证、文件完整性和自动清理。
