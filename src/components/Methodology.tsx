import { ShieldCheck, Database, Map, ClipboardList } from "lucide-react";

export default function Methodology() {
  return (
    <div className="max-w-4xl mx-auto space-y-12 pb-20">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 lg:p-12">
        <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight mb-4">
          SWPPP Data Collection Methodology
        </h1>
        <p className="text-slate-500 mb-10 leading-relaxed">
          The following outlines our automated approach to gathering regulatory
          and environmental data for Stormwater Pollution Prevention Plans.
        </p>

        <div className="space-y-12">
          {/* Endangered Species */}
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center border border-amber-100">
                <ShieldCheck className="h-6 w-6" />
              </div>
              Endangered Species (FWS IPaC)
            </h2>
            <div className="pl-13 space-y-3">
              <p className="text-sm font-bold text-slate-700 uppercase tracking-wider">
                Approach: County boundary polygon query
              </p>
              <ul className="space-y-2 list-decimal list-inside text-slate-600 text-sm leading-relaxed">
                <li>Get county FIPS from Census geocoding</li>
                <li>Fetch county boundary polygon from TIGERweb REST API</li>
                <li>Convert GeoJSON to WKT, query IPaC</li>
                <li>
                  Filter to Endangered only (status code 'E'), exclude plants
                  (group code 'Q')
                </li>
              </ul>
              <p className="text-sm text-slate-600">
                <span className="font-semibold">Returns:</span> Species matching
                ECOS county-level lookup
              </p>
              <div className="bg-amber-50 border-l-4 border-amber-400 p-4 rounded-r-lg">
                <p className="text-xs text-amber-800 leading-relaxed italic">
                  <span className="font-bold">Note:</span> IPaC may return
                  slightly more species than ECOS website due to more precise
                  range polygon data (e.g., Penasco least chipmunk). This is
                  more conservative for compliance.
                </p>
              </div>
            </div>
          </section>

          {/* Receiving Waters */}
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100">
                <Database className="h-6 w-6" />
              </div>
              Receiving Waters (EPA ATTAINS + USGS WBD)
            </h2>
            <div className="pl-13 space-y-3">
              <p className="text-sm font-bold text-slate-700 uppercase tracking-wider">
                Approach: HUC12 watershed boundary defines project reach
              </p>
              <ul className="space-y-2 list-decimal list-inside text-slate-600 text-sm leading-relaxed">
                <li>Identify HUC12 containing project coordinates</li>
                <li>Query ALL waterbodies (assessment units) in that HUC12</li>
                <li>Get names + impairment status for each waterbody</li>
              </ul>
              <p className="text-xs text-slate-500 italic">
                Typical HUC12: 10,000–40,000 acres (appropriate regulatory
                scope)
              </p>
              <p className="text-sm text-slate-600">
                <span className="font-semibold">Returns:</span> Complete list of
                receiving waters, not just impaired. Watershed centroid used
                separately for MS4 operator search.
              </p>
            </div>
          </section>

          {/* Soil Composition */}
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-green-50 text-green-600 flex items-center justify-center border border-green-100">
                <Map className="h-6 w-6" />
              </div>
              Soil Composition (USDA SSURGO)
            </h2>
            <div className="pl-13 space-y-3">
              <p className="text-sm font-bold text-slate-700 uppercase tracking-wider">
                Approach: Project-scaled sampling polygon via 2-step API
              </p>
              <ul className="space-y-2 list-decimal list-inside text-slate-600 text-sm leading-relaxed">
                <li>POST polygon to create AOI → returns AOI ID</li>
                <li>Query map units using AOI ID → returns soil data</li>
                <li>Format top 2 soil associations by coverage %</li>
              </ul>
              <p className="text-xs text-slate-500">
                <span className="font-bold">Sample area:</span> project acreage
                × 1.1 (10% buffer) |{" "}
                <span className="font-bold">Minimum: 1 acre</span> |{" "}
                <span className="font-bold">Maximum: 50 acres</span>
              </p>
              <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl">
                <p className="text-xs text-slate-600 leading-relaxed italic">
                  <span className="font-bold">Why:</span> Fixed 259-acre sample
                  was 26× oversample for small projects.
                </p>
              </div>
            </div>
          </section>

          {/* MS4 Operator */}
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100">
                <ClipboardList className="h-6 w-6" />
              </div>
              MS4 Operator (EPA ECHO)
            </h2>
            <div className="pl-13 space-y-3">
              <p className="text-sm font-bold text-slate-700 uppercase tracking-wider">
                Approach: Distance-first scoring from watershed centroid
              </p>
              <ul className="space-y-2 list-disc list-inside text-slate-600 text-sm leading-relaxed">
                <li>15-mile search radius from HUC12 centroid</li>
                <li>Municipal facilities prioritized over special-purpose</li>
                <li>
                  Special-purpose MS4s (DOT, university, airport) auto-rejected
                </li>
                <li>
                  Fallback: Geocoder city/county when only special-purpose found
                </li>
                <li>
                  Handles delegated states (TX TPDES) where EPA lacks municipal
                  data
                </li>
              </ul>
            </div>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-slate-100 flex justify-between items-center text-[10px] text-slate-400 font-medium uppercase tracking-[0.2em]">
          <span>© SWPPPdoc System</span>
          <span>v9 — Jan 2026</span>
        </div>
      </div>
    </div>
  );
}
