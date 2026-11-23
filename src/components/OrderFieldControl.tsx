import { useState, type ChangeEventHandler, type HTMLInputTypeAttribute } from "react";
import { ExternalLink } from "lucide-react";
import { parseCoordinate } from "../utils";
import { formatDay } from "../documentQueue";

type Props = {
  newVersion: boolean;
  id: string;
  value: string | number;
  multiline?: boolean;
  type?: HTMLInputTypeAttribute;
  rawDate?: string;
  rows?: number;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  className: string;
  onChange?: ChangeEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  onBlur?: () => void;
  "aria-describedby"?: string;
  "aria-label"?: string;
};

export default function OrderFieldControl({ newVersion, multiline, rawDate, type, rows, ...control }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (newVersion && (control.disabled || control.readOnly)) {
    const value = type === "date" && control.value
      ? formatDay(String(control.value))
      : String(control.value ?? "").trim() || rawDate || "";
    const long = value.length > 320;
    return (
      <div className="order-read-field">
        <output id={control.id} aria-live="off" aria-describedby={control["aria-describedby"]}
          aria-label={control["aria-label"]} className={value ? "order-value" : "order-value order-empty"}
          data-clamped={long && !expanded}>
          {value || "Not recorded"}
        </output>
        {long && <button type="button" className="order-value-toggle" aria-expanded={expanded}
          aria-controls={control.id} onClick={() => setExpanded(current => !current)}>
          {expanded ? "Show less" : "Show all"}
        </button>}
      </div>
    );
  }
  return multiline ? <textarea rows={rows} {...control} /> : <input type={type} {...control} />;
}

export function OrderMapLink({ latitude, longitude, newVersion }: { latitude: string; longitude: string; newVersion: boolean }) {
  const lat = parseCoordinate(latitude);
  const lon = parseCoordinate(longitude);
  if (newVersion) {
    const latitudeFormat = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)°?\s*[NS]?$/i;
    const longitudeFormat = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)°?\s*[EW]?$/i;
    if (!latitudeFormat.test(String(latitude ?? "").trim()) || Math.abs(Number(lat)) > 90
      || !longitudeFormat.test(String(longitude ?? "").trim()) || Math.abs(Number(lon)) > 180) {
      return <span className="text-xs text-slate-600">Check both coordinates to view the map.</span>;
    }
  }
  return <a href={`https://www.google.com/maps?q=${lat},${lon}`} target="_blank" rel="noopener noreferrer"
    className="text-xs text-brand-600 hover:text-brand-800 flex items-center hover:underline">
    View on Map <ExternalLink className="h-3 w-3 ml-1" />
  </a>;
}
