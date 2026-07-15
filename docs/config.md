# Matron Web configuration

Matron Web loads `config.json` from the application root. Reload the page (or fully restart Matron Desktop) after changing it.

The journal-native runtime uses these keys:

| Key                  | Purpose                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `journal_server_url` | matron-journal base URL. A relative path such as `/journal` is recommended for same-origin browser deployments. Empty or omitted asks at sign-in. |
| `brand`              | Product name shown in the login screen and sidebar. Defaults to `Matron`.                                                                         |
| `privacy_policy_url` | Optional link shown below the login form.                                                                                                         |

Example:

```json
{
    "journal_server_url": "/journal",
    "brand": "Matron",
    "privacy_policy_url": "https://matron.chat/privacy"
}
```

## Browser transport

matron-journal does not currently emit CORS headers, so browsers should normally reach it through a same-origin reverse proxy. The prefix is preserved for every HTTP and WebSocket endpoint: `/journal/snapshot`, `/journal/convo/…`, and `/journal/ws`.

During `pnpm start`, webpack proxies `/journal` to `http://127.0.0.1:9810`. Set `MATRON_JOURNAL_URL` to change that target.

Matron Desktop may use an absolute HTTPS URL. Its sandboxed preload exposes a narrowly scoped journal request bridge for HTTP; the WebSocket still connects directly.

Matrix homeserver, identity-server, crypto, calling, widget, and feature-flag settings are not part of Matron Web's configuration surface.
