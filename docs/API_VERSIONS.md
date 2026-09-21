# SAP Cloud ALM API versions

Every service calmcp talks to is on API version **`v1`** — that is the version in the URL path and
it has not changed. What moves between refreshes is the *spec revision* of each individual API.


| Artifact | Version | API | Service path |
| --- | --- | --- | --- |
| CALM_TKM | 1.0.31 | Tasks | `/calm-tasks/v1` |
| CALM_PJM | 1.0.12 | Projects | `/calm-projects/v1` |
| CALM_PH | 1.2.0 | Process Hierarchy | `/calm-processhierarchy/v1` |
| CALM_TM | 1.0.6 | Test Cases | `/calm-testmanagement/v1` |
| CALM_CDM_ODATA | 1.0.6 | Features | `/calm-features/v1` |
| CALM_SD | 1.0.4 | Documents | `/calm-documents/v1` |
| CALM_LMS | 1.0.0 *(content changed 2025-09-21)* | Landscape | `/calm-landscape/v1` |
| CALM_BSM | 1.0.0 | Status Events | `/bsm-service/v1` |
| CALM_ANALYTICS_ODATA | 1.0.0 | Analytics | `/calm-analytics/v1/odata/v4/analytics` |
| CALM_PM | 1.1.0 | Process Scopes | `/calm-processmanagement/v1` |
| CALM_PMGE | 1.0.0 | Custom Processes | `/calm-processauthoring/v1` |
| CALM_TM_PLAN | 1.0.2 | Test Plans *(BETA)* | `/calm-testmanagement-testplans/v1` |
| CALM_XLIB_APP | 1.0.4 | Cross-Library Applications | `/calm-crosslibraryapplications/v1` |
| CALM_XLIB_DEV | 1.0.4 | Cross-Library Developments | `/calm-crosslibrarydevelopments/v1` |
| CALM_XLIB_CON | 1.0.2 | Cross-Library Configurations | `/calm-crosslibraryconfigurations/v1` |
| CALM_XLIB_INT | 1.0.3 | Cross-Library Interfaces | `/calm-crosslibraryinterfaces/v1` |

Specs last pulled from the SAP Business Accelerator Hub on **2025-09-21**. That refresh added the
`us20` region to every service, SCIM access control lists to Landscape (same `1.0.0` version string,
different content, so compare bytes rather than version numbers), and priority, readiness, usage,
clean core level and upgrade impact classification codes to the four cross-library services.
