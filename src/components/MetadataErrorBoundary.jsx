import React from 'react';
import { criticalError } from '../utils/debugUtils';

/**
 * Error boundary specifically for metadata fetch failures
 * Prevents entire component tree from crashing due to metadata issues
 */
class MetadataErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { 
            hasError: false, 
            error: null,
            errorInfo: null,
            retryCount: 0
        };
        this.maxRetries = 2;
    }

    static getDerivedStateFromError(error) {
        // Update state so the next render will show the fallback UI
        return { hasError: true };
    }

    componentDidCatch(error, errorInfo) {
        // Log the error for debugging
        criticalError('MetadataErrorBoundary caught an error:', error, errorInfo);
        
        this.setState({
            error,
            errorInfo,
            hasError: true
        });

        // Automatically retry for certain types of errors
        if (this.state.retryCount < this.maxRetries && this.shouldRetry(error)) {
            setTimeout(() => {
                this.setState(prevState => ({
                    hasError: false,
                    error: null,
                    errorInfo: null,
                    retryCount: prevState.retryCount + 1
                }));
            }, 1000 * (this.state.retryCount + 1)); // Exponential backoff
        }
    }

    shouldRetry(error) {
        // Retry for network errors, but not for parsing errors
        const retryableErrors = [
            'NetworkError',
            'fetch',
            'timeout',
            'connection'
        ];
        
        const errorMessage = error.message?.toLowerCase() || '';
        return retryableErrors.some(keyword => errorMessage.includes(keyword));
    }

    handleRetry = () => {
        this.setState({
            hasError: false,
            error: null,
            errorInfo: null,
            retryCount: 0
        });
    };

    render() {
        if (this.state.hasError) {
            // Fallback UI for metadata failures
            return (
                <div className="metadata-error-boundary">
                    <div className="error-content">
                        <h4>Metadata Loading Error</h4>
                        <p>Unable to load NFT metadata. The listing is still functional.</p>
                        
                        {this.state.retryCount < this.maxRetries && (
                            <button 
                                onClick={this.handleRetry}
                                className="retry-button"
                                aria-label="Retry loading metadata"
                            >
                                Retry Loading
                            </button>
                        )}
                        
                        {this.props.showDetails && (
                            <details className="error-details">
                                <summary>Error Details</summary>
                                <pre>{this.state.error?.message}</pre>
                            </details>
                        )}
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

/**
 * Higher-order component to wrap components with metadata error boundary
 * @param {React.Component} WrappedComponent - Component to wrap
 * @param {Object} options - Options for error boundary
 * @returns {React.Component} Wrapped component
 */
export const withMetadataErrorBoundary = (WrappedComponent, options = {}) => {
    const WithErrorBoundary = (props) => (
        <MetadataErrorBoundary showDetails={options.showDetails}>
            <WrappedComponent {...props} />
        </MetadataErrorBoundary>
    );
    
    WithErrorBoundary.displayName = `withMetadataErrorBoundary(${WrappedComponent.displayName || WrappedComponent.name})`;
    
    return WithErrorBoundary;
};

/**
 * Hook for handling metadata loading errors gracefully
 * @param {Function} metadataLoader - Function that loads metadata
 * @returns {Object} Loading state and error handling
 */
export const useMetadataWithErrorHandling = (metadataLoader) => {
    const [state, setState] = React.useState({
        loading: false,
        error: null,
        data: null,
        retryCount: 0
    });

    const maxRetries = 2;

    const loadMetadata = React.useCallback(async (force = false) => {
        if (state.loading && !force) return;
        
        setState(prev => ({ ...prev, loading: true, error: null }));
        
        try {
            const data = await metadataLoader();
            setState(prev => ({
                ...prev,
                loading: false,
                data,
                error: null,
                retryCount: 0
            }));
        } catch (error) {
            criticalError('Metadata loading failed:', error);
            
            setState(prev => ({
                ...prev,
                loading: false,
                error,
                retryCount: prev.retryCount + 1
            }));
            
            // Auto-retry for certain errors
            if (state.retryCount < maxRetries && shouldRetryError(error)) {
                setTimeout(() => {
                    loadMetadata(true);
                }, 1000 * (state.retryCount + 1));
            }
        }
    }, [metadataLoader, state.loading, state.retryCount]);

    const retry = () => {
        setState(prev => ({ ...prev, retryCount: 0 }));
        loadMetadata(true);
    };

    return {
        ...state,
        loadMetadata,
        retry,
        canRetry: state.retryCount < maxRetries
    };
};

/**
 * Determine if an error is worth retrying
 * @param {Error} error - Error to check
 * @returns {boolean} Whether to retry
 */
const shouldRetryError = (error) => {
    const retryableErrors = [
        'network',
        'timeout',
        'fetch',
        'connection',
        'rate limit'
    ];
    
    const errorMessage = error.message?.toLowerCase() || '';
    return retryableErrors.some(keyword => errorMessage.includes(keyword));
};

export default MetadataErrorBoundary;