# Environmental screen data follow-up audit

Ivan requested a fresh audit and reported that Rolling Hills appeared to lack all environmental fields despite Generated status.

## Verified defects

The successful job-order formatter contained Wolf Creek East/West Branch, Whooping crane and Comanche County MS4. Its PDF was verified against current Dropbox path, ID, size and hash. Soil genuinely failed with USDA 502; a fresh health query also returns 502. The child return exposed only MS4/species, and the parent callback persisted status/notes without the environmental values. The screen therefore stayed blank despite nonblank PDF inputs. This is separate from the generation-status fix.

A fresh independent audit reproduced a cross-tab lookup race: unchanged local status/address were omitted from the patch, so a lookup could overwrite inputs after another tab approved or relocated the order. The backend compares expected values only for fields included in the patch.

## Repair contract

Add an environmental-data object from the actual PDF formatter to the verified job-order return. Both router completion branches copy only known, nonblank string values from the same verified JO receipt row, use callback CAS, and never replace different nonblank staff values. Preserve soil failure, MS4/county/manual review notes, lifecycle statuses, PDF validation, workflow connections and other nodes.

Lookup provenance saves include unchanged lifecycle and geographic/template/acreage inputs in the patch and its expectations. Known source changes suppress earlier lookup values. If processing begins during the request, reject the provenance save and display the specific reason. Ordinary saves and unrelated staff phone edits stay independent.

## Historical correction

The fresh 645-row snapshot exactly matched the previous release. All 26 Generated corrections remained status-only and matched 26 orders with 68 current Dropbox receipts. Ten Generated orders had 16 blank screen fields recoverable from successful PDF formatter output with unchanged provenance. Those blanks were filled through complete source-row CAS and read back. Status, review metadata and unrelated fields stayed unchanged; no generation run was triggered. Rolling Hills, North Yard and Arbors each recovered waterway, species and MS4 values. Seven older orders recovered waterway values.

The missing-folder order remains excluded. Newton's supplemental run has different current provenance, so no values were copied from it. The 64 Approved rows date January–October 10; they do not establish a current generation outcome. Of 32 Pending-with-folder rows, 30 predate November 5; the newer two remain held for missing folder/later staff note. No further recent generated order is proved missed. No new production order was created solely for testing.

## Validation and release

New return/callback tests cover both completion branches, linked receipts versus malformed/unverified/other-row evidence, unknown/malformed values, blanks, staff values and CAS conflicts. Cross-tab tests cover remote approval, address/template/acreage/coordinate changes, known local changes, processing transitions and unrelated edits. Build and 159 focused tests pass. The full serial suite has 3,813 passing tests and the unchanged emailVerifyPassCandidates failure. Two further callback-shape regression cases were added and pass after the final correction. Canonical workflow conversion equals each target: one Set assignment and three Code bodies; graph, settings and active state unchanged. Claude Opus 5.5 review round 2 found that the router approval snapshot originally contained only six fields. The helper now adds the five environmental source fields, requires each field to be present before syncing, and skips unchanged values. The actual Normalize code is replayed in tests, including the original six-key shape from in-flight runs. All 36 job-order nodes call the patched child. Actual saved PDF comparison is being checked before final release verification. Data correction receipts are under ~/.claude/backups/proswppp-environment-data-sync-20261117/.
