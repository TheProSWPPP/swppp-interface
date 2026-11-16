# Environmental screen data follow-up audit

Ivan requested a fresh audit and reported that Rolling Hills appeared to lack all environmental fields despite Generated status.

## Verified defects
The actual successful job-order formatter contained Wolf Creek East/West Branch, Whooping crane and Comanche County MS4. Its PDF was verified by current Dropbox path, ID, size and hash. Soil lookup genuinely failed with USDA502; a fresh public health query also returns502. The child return exposed only MS4/species, and the parent status callback persisted environmental status/notes but none of the underlying values. Consequently the screen was blank despite nonblank PDF inputs. This is independent of the generation-status fix.

A fresh independent audit also reproduced a cross-tab lookup race: an unchanged local status/address was omitted from the patch, so a lookup could overwrite inputs after another tab approved or relocated the order. The backend intentionally compares expected values only for keys in the patch.

## Repair contract
Add a typed environmental-data object from the actual PDF formatter to the verified job-order return. Both router completion branches copy only known, nonblank string fields from the same verified JO receipt row, use existing callback CAS, and never replace different nonblank staff values. Keep soil failure and MS4/county/manual review notes, status semantics, PDF validation, workflow connections and all other nodes unchanged.

Lookup provenance saves now include unchanged lifecycle and geographic/template/acreage inputs in both patch and expectations. Known source changes suppress earlier lookup business values. If processing begins during the request, reject its provenance save and display the specific reason. Ordinary saves and unrelated staff phone edits remain independent.

## Historical boundary
A fresh645-row snapshot exactly matched the previous release snapshot. All26Generated corrections remained status-only and matched26current-Dropbox-verified orders68receipts. Ten Generated orders have16blank screen fields recoverable from actual verified PDF formatter output with unchanged provenance. Filled only those blanks behind complete source-row CAS; keep Generated and all review metadata unchanged. Exclude the missing-folder order and Newton's supplemental run where current provenance differs. The10updateswereapplied andreadback:16fieldsrestored;statusandreviewmetadataunchanged. No PDF regeneration or send was triggered.

The64Approved rows are January–October10 historical rows, not current runs. Of32Pending-with-folder rows,30predateNovember5; the newer two remain held for missing folder/later staff note. No further recent generated order is proved missed. A positive new production order has not been triggered solely for testing.

## Validation
New callback/return tests exercise both completion branches, valid linked receipt vs malformed/unverified/other-row evidence, unknown/malformed fields, blank values, existing staff values and CAS conflicts. Cross-tab tests exercise remote approval, address/template/acreage/coordinate changes, known local source changes, processing transition and unrelated edits. Build and157focused tests pass. Canonical workflow conversion equals each target exactly: one Set assignment and two Code bodies; graph/settings/active state unchanged. Independent Claude Opus5.5 review is running before release verification.
