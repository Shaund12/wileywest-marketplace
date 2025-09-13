import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority"

import { cn } from "../../lib/utils"

const holographicVariants = cva(
  "relative overflow-hidden rounded-lg border transition-all duration-300",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground shadow-sm",
        neon: "bg-card/50 border-neon-cyan shadow-lg shadow-neon-cyan/20 hover:shadow-neon-cyan/40",
        cyber: "bg-gradient-to-br from-card to-card/50 border-primary/50 shadow-lg shadow-primary/20",
        holographic: "bg-gradient-to-br from-neon-cyan/5 via-neon-pink/5 to-neon-purple/5 border-gradient backdrop-blur-sm",
      },
      size: {
        default: "p-6",
        sm: "p-4",
        lg: "p-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const HolographicCard = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "div"
  
  return (
    <Comp
      className={cn(holographicVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    >
      {variant === "holographic" && (
        <div className="absolute inset-0 bg-gradient-to-r from-neon-cyan/10 via-transparent to-neon-pink/10 opacity-30 animate-pulse" />
      )}
      {props.children}
    </Comp>
  )
})
HolographicCard.displayName = "HolographicCard"

export { HolographicCard, holographicVariants }