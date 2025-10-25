import { toast } from "sonner"
import { CheckCircle, XCircle, AlertCircle, Info } from "lucide-react"

export function showToast(message, type = "default", options = {}) {
  const icons = {
    success: CheckCircle,
    error: XCircle,
    warning: AlertCircle,
    info: Info,
  }
  
  const Icon = icons[type]
  
  const toastOptions = {
    className: "cyber-toast",
    style: {
      background: type === "success" 
        ? "rgba(0, 255, 136, 0.1)" 
        : type === "error"
        ? "rgba(255, 0, 128, 0.1)"
        : type === "warning"
        ? "rgba(255, 255, 0, 0.1)"
        : "rgba(0, 255, 255, 0.1)",
      border: type === "success"
        ? "1px solid rgba(0, 255, 136, 0.3)"
        : type === "error"
        ? "1px solid rgba(255, 0, 128, 0.3)"
        : type === "warning"
        ? "1px solid rgba(255, 255, 0, 0.3)"
        : "1px solid rgba(0, 255, 255, 0.3)",
      color: type === "success"
        ? "#00ff88"
        : type === "error"
        ? "#ff0080"
        : type === "warning"
        ? "#ffff00"
        : "#00ffff",
      backdropFilter: "blur(16px)",
    },
    ...options,
  }

  const content = Icon ? (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4" />
      <span>{message}</span>
    </div>
  ) : message

  switch (type) {
    case "success":
      return toast.success(content, toastOptions)
    case "error":
      return toast.error(content, toastOptions)
    case "warning":
      return toast.warning(content, toastOptions)
    case "info":
      return toast.info(content, toastOptions)
    default:
      return toast(content, toastOptions)
  }
}

export { toast }