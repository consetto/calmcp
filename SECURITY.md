# Security policy

## Supported versions

Security fixes go into the latest release. From 1.0 on, the latest minor version of the current
major version is supported.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
[Report a vulnerability](https://github.com/consetto/calmcp/security/advisories/new). Do not open a
public issue.

Include what is affected (stdio, HTTP transport, XSUAA sign-in, a tool), how to reproduce it, and
the impact you see. Do not include credentials, tenant names or customer data.

You will get an answer within five working days. Fixes are released as soon as they are ready and
credited in the advisory unless you prefer otherwise.

## Scope

calmcp sits between AI clients and SAP Cloud ALM. Reports about these are especially welcome:

- Authentication and authorization of the HTTP transport (XSUAA, MCP OAuth, API key, CORS).
- Anything that lets a caller write without the Writer scope or the write switches.
- Text from Cloud ALM (titles, descriptions, documents) that can make calmcp write or send data
  somewhere it should not, for example through rich text.
- Leaks of tokens, client secrets or Cloud ALM data into logs, errors or packages.

Design limits that are not vulnerabilities: every caller reads and writes Cloud ALM with the one
technical identity of the destination or OAuth client, so the role collections decide which tools a
caller gets, not what the read tools can see (the Cloud ALM API accepts client credentials only).

Vulnerabilities in SAP Cloud ALM or SAP BTP themselves go to SAP.
