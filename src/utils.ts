import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function parseCoordinate(coord: string): string {
  if (!coord) return "0";
  const normalized = coord.toUpperCase();
  const isNegative = normalized.includes("S") || normalized.includes("W");
  // Remove all non-numeric characters except dot and minus
  const numericString = coord.replace(/[^\d.-]/g, "");
  const value = parseFloat(numericString);

  if (isNaN(value)) return "0";

  // Apply sign based on direction if present, otherwise trust the number
  if (isNegative) {
    return (-Math.abs(value)).toString();
  }
  return value.toString();
}
