# SWPPP Documentation System

Professional interface for SWPPP document automation and management.

## Features

- **Dashboard**: Real-time stats on project status and queue.
- **Triage**: Review and accept new job orders coming from API.
- **Dynamic Documents**: Required documents list changes based on State Templates (e.g., Texas Small).
- **Automation**: Automatic County extraction from coordinates.
- **Financials**: Integrated invoice tracking and QuickBooks generation.
- **Archive**: Deleted projects are archived for 30 days before permanent removal.

## Setup

1.  Run `npm install`
2.  Run `npm run build`
3.  Run `npm start` (Starts the Express server)

## API Integration (n8n / HTTP)

Endpoint: `POST /api/projects`

### **Payload Fields**

| Field                 | Description                             |
| :-------------------- | :-------------------------------------- |
| `projectName`         | Name of the project                     |
| `projectAddress`      | Full address of the site                |
| `projectStartDate`    | Format: `YYYY-MM-DD`                    |
| `projectFinishDate`   | Format: `YYYY-MM-DD`                    |
| `stateTemplateId`     | The ID of the state template            |
| `stateTemplateName`   | Alternatively, the name (e.g., `TX SM`) |
| `latitude`            | Decimal latitude                        |
| `longitude`           | Decimal longitude                       |
| `specialRequirements` | Maps to the **Notes** field in the UI   |
| `landDisturbanceArea` | Estimated acres                         |

## Database

This project uses **PostgreSQL** for permanent storage.
On Railway, ensure the `DATABASE_URL` environment variable is set to your PostgreSQL connection string.
