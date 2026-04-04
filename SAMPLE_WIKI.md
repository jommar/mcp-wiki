# Team Wiki Template (Short)

> Minimal structure for Wiki Explorer MCP. Replace placeholders and keep headings stable.

## Quick Start

1. Replace `<placeholders>` with real values.
2. Keep this H2/H3 structure so section keys remain predictable.
3. Start with critical docs first: setup, architecture, API, incidents.

## Project Overview

### Purpose

Lorem ipsum dolor sit amet. Describe what the project does, who it serves, and why it exists.

### Scope

| In Scope | Out of Scope |
|---|---|
| `<scope-a>` | `<out-a>` |
| `<scope-b>` | `<out-b>` |

## Architecture

### High-Level Design

```text
client -> api -> services -> datastore
```

### Repository Structure

```text
project/
|- src/
|- test/
`- docs/
```

## API and Contracts

### Endpoint Standards

- Route pattern: `/v1/<resource>`
- IDs: `<uuid|numeric>`
- Timestamps: ISO 8601 UTC

### Error Format

```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "errors": [{ "field": "name", "message": "Required" }]
}
```

## Development Workflow

### Local Setup

```bash
<package-manager> install
cp .env.example .env
<package-manager> run dev
```

### Common Commands

```bash
<package-manager> run test
<package-manager> run lint
<package-manager> run build
```

## Operations

### Environments

| Environment | Purpose |
|---|---|
| Development | Day-to-day development |
| Staging | Pre-production verification |
| Production | Live traffic |

### Incident Basics

1. Check logs and alerts.
2. Identify blast radius.
3. Apply rollback or mitigation.
4. Post incident summary in `<channel>`.

## Ownership

| Area | Team | Contact |
|---|---|---|
| `<api>` | `<team>` | `<channel-or-email>` |
| `<infra>` | `<team>` | `<channel-or-email>` |

## Change Log

### YYYY-MM-DD

- Initial template created.
