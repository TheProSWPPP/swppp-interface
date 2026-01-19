import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(dateStr: string): string {
  try {
    // If already in MM/DD/YY format, return as is
    if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(dateStr)) {
      return dateStr;
    }

    const date = new Date(dateStr);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const year = String(date.getFullYear()).slice(-2);
    return `${month}/${day}/${year}`;
  } catch (e) {
    return dateStr;
  }
}

// Convert various date formats to YYYY-MM-DD for date input fields
export function toDateInputFormat(dateStr: string | undefined): string {
  if (!dateStr) return "";

  try {
    // If already YYYY-MM-DD, return as is
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return dateStr;
    }

    let date: Date;

    // Handle slash-separated dates
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(dateStr)) {
      const parts = dateStr.split("/");
      const part0 = parseInt(parts[0]);
      const part1 = parseInt(parts[1]);
      const part2 = parts[2];

      let day, month, year;

      // Determine format based on values and year length
      if (part2.length === 4) {
        // Four-digit year - likely DD/MM/YYYY format
        if (part0 > 12) {
          // First part > 12, must be DD/MM/YYYY
          day = part0;
          month = part1 - 1;
          year = parseInt(part2);
        } else if (part1 > 12) {
          // Second part > 12, must be MM/DD/YYYY
          month = part0 - 1;
          day = part1;
          year = parseInt(part2);
        } else {
          // Ambiguous - assume DD/MM/YYYY (international standard)
          day = part0;
          month = part1 - 1;
          year = parseInt(part2);
        }
      } else {
        // Two-digit year - assume MM/DD/YY (US format)
        month = part0 - 1;
        day = part1;
        year = 2000 + parseInt(part2);
      }

      date = new Date(year, month, day);
    } else {
      date = new Date(dateStr);
    }

    if (isNaN(date.getTime())) return "";

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  } catch (e) {
    return "";
  }
}

// Convert YYYY-MM-DD from date input to MM/DD/YY for storage
export function fromDateInputFormat(dateStr: string): string {
  if (!dateStr) return "";

  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;

    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const year = String(date.getFullYear()).slice(-2);
    return `${month}/${day}/${year}`;
  } catch (e) {
    return dateStr;
  }
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
  coord: string | number | undefined | null,
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
