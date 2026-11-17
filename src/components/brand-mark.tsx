import { cn } from "@/lib/utils";

/** The Unifeye mark: a camera viewfinder around a lens, on a rounded tile. Matches public/icon.svg. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("grid shrink-0 place-items-center bg-primary text-primary-foreground", className)}>
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round" className="size-full" aria-hidden="true">
        <path d="M14 24v-6a4 4 0 0 1 4-4h6M40 14h6a4 4 0 0 1 4 4v6M50 40v6a4 4 0 0 1-4 4h-6M24 50h-6a4 4 0 0 1-4-4v-6" />
        <circle cx="32" cy="32" r="7.5" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}
