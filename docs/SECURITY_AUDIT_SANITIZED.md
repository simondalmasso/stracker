        # P0 Secret Audit — Sanitized

        `BASE_SHA=923cac9c9bcc0b7e05701dd1018e61a454d0f478`

        This report contains paths, classifications and abbreviated commit identifiers only. Secret values, cookies, tokens, coordinates and private sharing URLs were not copied into this report.

        | Severity | Finding type | Affected path(s) | Classification | First seen | Last seen | Rotation | Recommended action |
        |---|---|---|---|---|---|---|---|
        | CRITICAL | sensitive_path_in_history | `.env` | likely_real | 9b96eb620c5e | 9b96eb620c5e | required_if_active | remove from tracked tree where safe, keep ignored, and rotate active credentials outside Git |
| HIGH | sensitive_path_in_history | `nextjs-ui/gemini-analysis-input.json` | data_or_artifact | d99465053d57 | d99465053d57 | not_applicable | remove from tracked tree where safe, keep ignored, and rotate active credentials outside Git |
| HIGH | sensitive_path_in_history | `public/gemini-analysis-input.json` | data_or_artifact | d99465053d57 | d99465053d57 | not_applicable | remove from tracked tree where safe, keep ignored, and rotate active credentials outside Git |
| HIGH | sensitive_path_in_history | `tool-results/read_1782958675672_032cad2ac45c.txt` | data_or_artifact | 9b96eb620c5e | 9b96eb620c5e | not_applicable | remove from tracked tree where safe, keep ignored, and rotate active credentials outside Git |
| HIGH | hardcoded_private_coordinates | `tracker_map.py, src/app/api/points/route.ts` | likely_real_configuration_or_code_reference | history_present | 923cac9c9bcc | not_applicable | move private configuration out of source and complete manual rotation when applicable |
| CRITICAL | location_sharing_endpoint_or_url | `tracker_map.py, nextjs-ui/tracker_map.py` | likely_real_configuration_or_code_reference | history_present | 923cac9c9bcc | required_if_active | move private configuration out of source and complete manual rotation when applicable |
| LOW | cookie_identifier_references | `tracker_map.py, src/components/tracker/CookiesBlock.tsx` | likely_real_configuration_or_code_reference | history_present | 923cac9c9bcc | not_required_for_names_only | move private configuration out of source and complete manual rotation when applicable |
| HIGH | client_generated_bearer_token | `src/lib/auth.ts, src/lib/api-client.ts` | likely_real_configuration_or_code_reference | history_present | 923cac9c9bcc | not_applicable | move private configuration out of source and complete manual rotation when applicable |

        ## Interpretation

        - `likely_real` means non-empty material did not look like a documented placeholder. It was not displayed or used.
        - `required_if_active` means the operator must rotate or revoke the corresponding live credential/session outside this PR.
        - Source-level cookie names are identifiers, not cookie values; names alone do not require rotation.
        - Git history was not rewritten. Historical exposure remains an open manual remediation item.
