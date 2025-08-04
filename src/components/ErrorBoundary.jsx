import React from 'react';

/**
 * Error Boundary Component
 * Catches JavaScript errors anywhere in the child component tree and displays a fallback UI
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { 
      hasError: false, 
      error: null, 
      errorInfo: null 
    };
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    // Log error details for debugging
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    
    // Update state with error details
    this.setState({
      error: error,
      errorInfo: errorInfo
    });

    // You can also log the error to an error reporting service here
    // Example: Sentry.captureException(error);
  }

  render() {
    if (this.state.hasError) {
      // Custom fallback UI
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default fallback UI
      return (
        <div className="error-boundary">
          <div className="error-container">
            <div className="error-icon">⚠️</div>
            <h2>Something went wrong</h2>
            <p>
              We're sorry, but something unexpected happened. Please try refreshing the page or contact support if the problem persists.
            </p>
            
            {process.env.NODE_ENV === 'development' && this.state.error && (
              <details className="error-details">
                <summary>Error Details (Development Only)</summary>
                <div className="error-stack">
                  <h4>Error:</h4>
                  <pre>{this.state.error && this.state.error.toString()}</pre>
                  
                  {this.state.errorInfo && (
                    <>
                      <h4>Component Stack:</h4>
                      <pre>{this.state.errorInfo.componentStack}</pre>
                    </>
                  )}
                </div>
              </details>
            )}

            <div className="error-actions">
              <button 
                className="primary-button"
                onClick={() => window.location.reload()}
              >
                Reload Page
              </button>
              <button 
                className="secondary-button"
                onClick={() => window.history.back()}
              >
                Go Back
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Higher-order component for wrapping components with error boundary
 */
export function withErrorBoundary(Component, fallbackComponent = null) {
  return function WrappedComponent(props) {
    return (
      <ErrorBoundary fallback={fallbackComponent}>
        <Component {...props} />
      </ErrorBoundary>
    );
  };
}

/**
 * Hook for functional components to handle errors
 */
export function useErrorHandler() {
  const [error, setError] = React.useState(null);

  const resetError = React.useCallback(() => {
    setError(null);
  }, []);

  const catchError = React.useCallback((error, errorInfo) => {
    console.error('Error caught by useErrorHandler:', error, errorInfo);
    setError({ error, errorInfo });
  }, []);

  // Throw error to be caught by ErrorBoundary
  if (error) {
    throw error.error;
  }

  return { catchError, resetError };
}

/**
 * Component-specific error boundaries
 */
export function WalletErrorBoundary({ children }) {
  return (
    <ErrorBoundary
      fallback={
        <div className="wallet-error">
          <div className="error-icon">🔐</div>
          <h3>Wallet Connection Error</h3>
          <p>There was an issue connecting to your wallet. Please try again.</p>
          <button 
            className="primary-button"
            onClick={() => window.location.reload()}
          >
            Retry Connection
          </button>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
}

export function MarketplaceErrorBoundary({ children }) {
  return (
    <ErrorBoundary
      fallback={
        <div className="marketplace-error">
          <div className="error-icon">🏪</div>
          <h3>Marketplace Error</h3>
          <p>There was an issue loading marketplace data. Please refresh the page.</p>
          <button 
            className="primary-button"
            onClick={() => window.location.reload()}
          >
            Refresh Marketplace
          </button>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
}

export function NFTErrorBoundary({ children }) {
  return (
    <ErrorBoundary
      fallback={
        <div className="nft-error">
          <div className="error-icon">🖼️</div>
          <h3>NFT Loading Error</h3>
          <p>Unable to load NFT data. Please check the contract address and token ID.</p>
          <button 
            className="secondary-button"
            onClick={() => window.history.back()}
          >
            Go Back
          </button>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
}

export default ErrorBoundary;