# Connecting calmcp to Microsoft Copilot Studio

The standard way to consume calmcp is from an MCP-capable AI tool where a **BTP user signs in
interactively** (see the [Endpoint authentication](../README.md#endpoint-authentication-http-transport)
section of the README). Microsoft Copilot Studio is different: it is a non-interactive, server-to-server
caller, so it uses a **static API key** instead of a per-user login.

> API-key access authenticates the *caller* (the Copilot Studio agent), not an end user. Every request
> still reads SAP Cloud ALM as the bound Destination's technical identity, so there is no per-user data
> filtering. If you need per-user identity, use the interactive OAuth path instead.

## Prerequisites

- calmcp deployed to SAP BTP Cloud Foundry (see [Deploy to SAP BTP Cloud Foundry](../README.md#deploy-to-sap-btp-cloud-foundry)).
- The Cloud ALM **destination** configured (see [Configure the destination](../README.md#configure-the-destination)).

## Steps

1. **Set an API key** on the deployed app and restage:

   ```bash
   cf set-env calmcp-srv CALM_HTTP_API_KEY "$(openssl rand -base64 48)"
   cf restage calmcp-srv
   ```

   This protects `/mcp` with a shared secret. It coexists with XSUAA OAuth, so interactive clients
   (Claude Desktop, Cursor, VS Code) keep working on the same endpoint.

2. **Create a custom connector** in Power Platform (Power Apps or Power Automate, then Custom
   connectors, then New, then Import an OpenAPI file). Import
   [`copilot-studio/calmcp-connector.json`](../copilot-studio/calmcp-connector.json) from this repo.
   Before importing, edit its `host` to your Cloud Foundry route, for example
   `calmcp-srv-<suffix>.cfapps.eu10.hana.ondemand.com`.

3. **Create the connection.** The connector uses API-key authentication with the `Authorization`
   header. When prompted for the key, enter the full header value including the scheme:

   ```
   Bearer <your-key>
   ```

4. **Add the connector to your agent** in Copilot Studio (Tools, then Add a tool, then the custom
   connector) and call calmcp. The four tools are `calm_list`, `calm_get`, `calm_analytics`, and
   `calm_resources`.

## Verify

```bash
ROUTE=https://calmcp-srv-<suffix>.cfapps.eu10.hana.ondemand.com
# Without the key -> 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$ROUTE/mcp" \
  -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# With the key + MCP initialize -> 200
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$ROUTE/mcp" \
  -H "Authorization: Bearer <your-key>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}'
```

## Rotate or revoke the key

- **Rotate:** set a new `CALM_HTTP_API_KEY`, restage, then update the Copilot Studio connection.
- **Revoke:** clear `CALM_HTTP_API_KEY` and restage. If XSUAA is still bound, `/mcp` remains protected
  by OAuth; otherwise the endpoint would be open, so do not leave it unauthenticated and exposed.

## Notes

- The built-in Copilot Studio MCP wizard (OAuth 2.0 dynamic discovery) is an alternative to the custom
  connector but is still rolling out per tenant and region, and needs extra OAuth handling on the
  server side. The API-key custom connector above is the reliable path today.
