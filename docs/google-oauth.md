# Google OAuth 配置

Google 模式通过服务端验证账号身份和邮箱白名单，仅影响上传；下载者无需登录。本文只使用示例值，不包含实际项目、邮箱或客户端凭据。

## 创建客户端

1. 在 Google Cloud Console 创建自己的项目，打开 Google Auth Platform。
2. 配置应用名称、支持邮箱、受众和开发者联系方式。
3. 创建 **Web 应用** 类型的 OAuth 客户端。
4. 设置自己站点的来源与回调，如下表。
5. 仅配置 `openid` 和 `https://www.googleapis.com/auth/userinfo.email`，实际授权请求使用 `openid email`。
6. 保存客户端 ID 和 Client Secret；在应用品牌设置中填写自己站点的首页和隐私说明链接。

| 配置项 | 示例 |
|---|---|
| 站点来源 | `https://drop.example.com` |
| 完整回调 URI | `https://drop.example.com/api/auth/google/callback` |
| 隐私说明 | `https://drop.example.com/privacy.html` |
| 客户端 ID | 使用自己的 Web OAuth 客户端 ID |
| 上传白名单 | `owner@example.com` |

回调路径固定为 `/api/auth/google/callback`，完整 HTTPS 地址必须与 Google 控制台精确一致。登录限定于回调域名，其他站点入口会引导到该域名。

## Workers 配置

建议在被 Git 忽略的 `wrangler.production.jsonc` 中设置：

```jsonc
{
  "vars": {
    "UPLOAD_AUTH_MODE": "google",
    "UPLOAD_PASSWORD_REQUIRED": "true",
    "GOOGLE_CLIENT_ID": "YOUR_GOOGLE_CLIENT_ID",
    "GOOGLE_REDIRECT_URI": "https://drop.example.com/api/auth/google/callback",
    "GOOGLE_ALLOWED_EMAILS": "owner@example.com"
  }
}
```

这是需要合并到完整配置中的片段，不是完整 Wrangler 文件。其他绑定与额度配置继续保留。

使用 `npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.production.jsonc` 写入密钥。不要将 Client Secret 或 `APP_SECRET` 写进 Git。`GOOGLE_ALLOWED_EMAILS` 使用逗号分隔邮箱，按小写精确匹配，不合并点号或加号别名。

白名单为空、密钥缺失或回调配置错误时拒绝上传。Google 模式下旧密码及 `UPLOAD_PASSWORD_REQUIRED=false` 都不能绕过邮箱验证。修改白名单并部署后，原 Google 会话失效。

## 安全与生命周期

- 使用授权码、PKCE S256、随机 state 和 nonce。HttpOnly、Secure、SameSite=Lax 流程 Cookie 绑定当前浏览器；Durable Object 最多保留流程 10 分钟，回调原子消费，Alarm 清理过期流程；每 IP 最多保留 5 个未完成流程。
- 使用 `jose` 与 Google 公钥验证 RS256 签名、iss、aud、azp、exp、iat、nonce、sub 和 email_verified，再检查白名单。Google 访问令牌和刷新令牌不持久化。
- 登录 Cookie 为 HttpOnly、Secure、SameSite=Strict，有效期 1 小时；会话签名绑定客户端、回调和白名单，退出清除当前浏览器 Cookie。
- 未授权邮箱或无效 ID 令牌触发上传入口 60 秒锁定；刷新、换浏览器和并发请求不能绕过。取消授权和服务故障不计为邮箱验证失败。
- OAuth 回调是唯一允许跨站导航的 API，其余敏感 API 仍校验同源。应用日志不记录密码、接收码、授权码或令牌。

本地 `npm run dev` 使用密码模式；Google 集成测试使用模拟服务及测试 RSA 密钥，不需要真实账号。公开页面验证脚本必须通过 `LITE_DROP_URL` 显式指定目标；完整 OAuth 登录需在浏览器中验证。

Google 对只使用基础身份权限的流程提供测试授权规则豁免；应用自身仍须检查邮箱白名单，不能用 Google 测试用户名单代替上传权限控制。[官方受众说明](https://support.google.com/cloud/answer/15549945?hl=en)
