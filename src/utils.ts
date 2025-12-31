import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
