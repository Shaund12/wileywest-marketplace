import React from "react"
import { cn } from "../../lib/utils"

const Skeleton = ({ className, ...props }) => {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted loading-pulse", className)}
      {...props}
    />
  )
}

export { Skeleton }