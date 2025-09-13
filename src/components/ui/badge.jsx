import * as React from "react"
import { cva } from "class-variance-authority"

import { cn } from "../../lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
        // Cyberpunk variants
        neon: "border-neon-cyan bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20 neon-border-cyan",
        "neon-pink": "border-neon-pink bg-neon-pink/10 text-neon-pink hover:bg-neon-pink/20 neon-border-pink",
        "neon-green": "border-neon-green bg-neon-green/10 text-neon-green hover:bg-neon-green/20 neon-border-green",
        cyber: "border-primary bg-gradient-to-r from-primary/20 to-secondary/20 text-primary hover:from-primary/30 hover:to-secondary/30",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({ className, variant, ...props }) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }