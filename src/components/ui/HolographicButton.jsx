import React from 'react';
import { useSpring, animated } from '@react-spring/web';
import './HolographicButton.css';

const HolographicButton = ({ 
  children, 
  onClick, 
  variant = 'primary', 
  size = 'md',
  disabled = false,
  className = '',
  icon = null,
  ...props 
}) => {
  const [spring, api] = useSpring(() => ({
    scale: 1,
    rotateX: 0,
    rotateY: 0,
    config: { tension: 300, friction: 10 }
  }));

  const handleMouseEnter = () => {
    api.start({
      scale: 1.05,
      rotateX: 5,
      rotateY: 5,
    });
  };

  const handleMouseLeave = () => {
    api.start({
      scale: 1,
      rotateX: 0,
      rotateY: 0,
    });
  };

  const handleMouseDown = () => {
    api.start({ scale: 0.95 });
  };

  const handleMouseUp = () => {
    api.start({ scale: 1.05 });
  };

  const variantClass = {
    primary: 'holo-btn-primary',
    secondary: 'holo-btn-secondary',
    accent: 'holo-btn-accent',
    danger: 'holo-btn-danger',
    ghost: 'holo-btn-ghost'
  }[variant];

  const sizeClass = {
    sm: 'holo-btn-sm',
    md: 'holo-btn-md',
    lg: 'holo-btn-lg',
    xl: 'holo-btn-xl'
  }[size];

  return (
    <animated.button
      style={{
        transform: spring.scale.to(s => 
          `scale(${s}) perspective(1000px) rotateX(${spring.rotateX.get()}deg) rotateY(${spring.rotateY.get()}deg)`
        ),
      }}
      className={`holo-btn ${variantClass} ${sizeClass} ${disabled ? 'holo-btn-disabled' : ''} ${className}`}
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      disabled={disabled}
      {...props}
    >
      <span className="holo-btn-background"></span>
      <span className="holo-btn-border"></span>
      <span className="holo-btn-content">
        {icon && <span className="holo-btn-icon">{icon}</span>}
        <span className="holo-btn-text">{children}</span>
      </span>
      <span className="holo-btn-glow"></span>
    </animated.button>
  );
};

export default HolographicButton;