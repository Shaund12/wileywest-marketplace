import React from 'react';
import './CyberSkeleton.css';

const CyberSkeleton = ({ 
  variant = 'text', 
  width, 
  height, 
  className = '',
  animate = true,
  lines = 3,
  ...props 
}) => {
  const renderContent = () => {
    switch (variant) {
      case 'text':
        return Array.from({ length: lines }, (_, index) => (
          <div 
            key={index}
            className={`cyber-skeleton-line ${index === lines - 1 ? 'cyber-skeleton-line-short' : ''}`}
            style={{
              width: index === lines - 1 ? '70%' : '100%',
              animationDelay: `${index * 0.1}s`
            }}
          />
        ));
      
      case 'card':
        return (
          <>
            <div className="cyber-skeleton-image" />
            <div className="cyber-skeleton-content">
              <div className="cyber-skeleton-line" style={{ width: '80%' }} />
              <div className="cyber-skeleton-line" style={{ width: '60%' }} />
              <div className="cyber-skeleton-line cyber-skeleton-line-short" style={{ width: '40%' }} />
            </div>
          </>
        );
      
      case 'avatar':
        return <div className="cyber-skeleton-avatar" />;
      
      case 'button':
        return <div className="cyber-skeleton-button" />;
      
      case 'image':
        return <div className="cyber-skeleton-image" />;
      
      case 'table':
        return (
          <div className="cyber-skeleton-table">
            {Array.from({ length: 5 }, (_, rowIndex) => (
              <div key={rowIndex} className="cyber-skeleton-row">
                {Array.from({ length: 4 }, (_, colIndex) => (
                  <div 
                    key={colIndex} 
                    className="cyber-skeleton-cell"
                    style={{ animationDelay: `${(rowIndex * 4 + colIndex) * 0.1}s` }}
                  />
                ))}
              </div>
            ))}
          </div>
        );
      
      default:
        return <div className="cyber-skeleton-line" />;
    }
  };

  const style = {
    width: width,
    height: height,
    ...props.style
  };

  return (
    <div 
      className={`cyber-skeleton ${animate ? 'cyber-skeleton-animate' : ''} cyber-skeleton-${variant} ${className}`}
      style={style}
      {...props}
    >
      {renderContent()}
      <div className="cyber-skeleton-glow" />
      <div className="cyber-skeleton-particles" />
    </div>
  );
};

// Preset components for common use cases
export const SkeletonText = (props) => <CyberSkeleton variant="text" {...props} />;
export const SkeletonCard = (props) => <CyberSkeleton variant="card" {...props} />;
export const SkeletonAvatar = (props) => <CyberSkeleton variant="avatar" {...props} />;
export const SkeletonButton = (props) => <CyberSkeleton variant="button" {...props} />;
export const SkeletonImage = (props) => <CyberSkeleton variant="image" {...props} />;
export const SkeletonTable = (props) => <CyberSkeleton variant="table" {...props} />;

export default CyberSkeleton;