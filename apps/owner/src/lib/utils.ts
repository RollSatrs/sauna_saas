import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Слияние классов Tailwind: последний конфликтующий побеждает. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
