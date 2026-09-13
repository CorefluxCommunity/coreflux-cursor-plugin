# Security policy

## Scope

This repository ships code that runs on developers' machines (the `coreflux-broker` MCP server
and Cursor hooks) and holds MQTT credentials for Coreflux brokers. Issues we treat as security
relevant include:

- credential leakage (passwords or secrets written to logs, files, tool output or chat);
- bypasses of the destructive-command approval hooks;
- the MCP server executing anything other than MQTT traffic to the configured broker;
- unsafe handling of broker responses (e.g. path traversal in `project_export`).

Vulnerabilities in the Coreflux broker itself should be reported to Coreflux at
<security@coreflux.org>.

## Reporting

Please do **not** open a public issue. Use
[GitHub private vulnerability reporting](https://github.com/CorefluxCommunity/coreflux-cursor-plugin/security/advisories/new)
or email <security@coreflux.org> with a description, reproduction steps and the plugin version
(`plugins/coreflux/.cursor-plugin/plugin.json`).

You will get an acknowledgement within 5 working days. Fixes are released as a patch version
with a changelog entry; we credit reporters unless they prefer otherwise.

## Supported versions

Only the latest release receives fixes. Upgrade through the Cursor Marketplace.
