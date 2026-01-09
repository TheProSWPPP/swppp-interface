import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatGeorgiaTime(dateStr: string): string {
  try {
    // If the input date doesn't include a timezone, assume it's UTC
    let date = new Date(dateStr);
    if (!dateStr.includes("Z") && !dateStr.includes("+")) {
      date = new Date(dateStr + "Z"); // Treat as UTC
    }

    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hour12: true,
    })
      .format(date)
      .replace(" at", ",")
      .replace(":00 ", " ")
      .replace(":00", "");
  } catch (e) {
    return dateStr;
  }
}

export function parseCoordinate(
  coord: string | number | undefined | null
): string {
  if (!coord) return "0";
  const coordStr = String(coord);
  const normalized = coordStr.toUpperCase();
  const isNegative = normalized.includes("S") || normalized.includes("W");
  // Remove all non-numeric characters except dot and minus
  const numericString = coordStr.replace(/[^\d.-]/g, "");
  const value = parseFloat(numericString);

  if (isNaN(value)) return "0";

  // Apply sign based on direction if present, otherwise trust the number
  if (isNegative) {
    return (-Math.abs(value)).toString();
  }
  return value.toString();
}

export function formatWaterwayUrl(address: string): string {
  if (!address) return "https://mywaterway.epa.gov/";
  // Replace spaces with %20 but KEEP commas as raw characters
  const formattedAddress = address.trim().replace(/ /g, "%20");
  return `https://mywaterway.epa.gov/community/${formattedAddress}/overview`;
}
