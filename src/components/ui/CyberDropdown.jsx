import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { useSpring, animated } from '@react-spring/web';
import './CyberDropdown.css';

const CyberDropdown = ({
  options = [],
  value = null,
  onChange = () => {},
  placeholder = 'Select an option...',
  disabled = false,
  searchable = false,
  multiSelect = false,
  className = '',
  error = false,
  size = 'md',
  variant = 'primary'
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedValues, setSelectedValues] = useState(multiSelect ? (Array.isArray(value) ? value : []) : value);
  const dropdownRef = useRef(null);
  const searchInputRef = useRef(null);

  // Animation for dropdown menu
  const menuAnimation = useSpring({
    opacity: isOpen ? 1 : 0,
    transform: isOpen ? 'translateY(0px) scale(1)' : 'translateY(-10px) scale(0.95)',
    config: { tension: 300, friction: 20 }
  });

  // Filter options based on search term
  const filteredOptions = options.filter(option =>
    option.label.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Handle outside click
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchable && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen, searchable]);

  const handleToggle = () => {
    if (!disabled) {
      setIsOpen(!isOpen);
    }
  };

  const handleOptionSelect = (option) => {
    if (multiSelect) {
      const newValues = selectedValues.includes(option.value)
        ? selectedValues.filter(v => v !== option.value)
        : [...selectedValues, option.value];
      setSelectedValues(newValues);
      onChange(newValues);
    } else {
      setSelectedValues(option.value);
      onChange(option.value);
      setIsOpen(false);
      setSearchTerm('');
    }
  };

  const getDisplayText = () => {
    if (multiSelect) {
      if (selectedValues.length === 0) return placeholder;
      if (selectedValues.length === 1) {
        const option = options.find(opt => opt.value === selectedValues[0]);
        return option ? option.label : placeholder;
      }
      return `${selectedValues.length} items selected`;
    } else {
      const option = options.find(opt => opt.value === selectedValues);
      return option ? option.label : placeholder;
    }
  };

  const isSelected = (optionValue) => {
    return multiSelect 
      ? selectedValues.includes(optionValue)
      : selectedValues === optionValue;
  };

  const sizeClass = {
    sm: 'cyber-dropdown-sm',
    md: 'cyber-dropdown-md',
    lg: 'cyber-dropdown-lg'
  }[size];

  const variantClass = {
    primary: 'cyber-dropdown-primary',
    secondary: 'cyber-dropdown-secondary',
    accent: 'cyber-dropdown-accent'
  }[variant];

  return (
    <div 
      ref={dropdownRef}
      className={`cyber-dropdown ${sizeClass} ${variantClass} ${disabled ? 'cyber-dropdown-disabled' : ''} ${error ? 'cyber-dropdown-error' : ''} ${isOpen ? 'cyber-dropdown-open' : ''} ${className}`}
    >
      <div 
        className="cyber-dropdown-trigger"
        onClick={handleToggle}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggle();
          }
        }}
      >
        <span className="cyber-dropdown-value">
          {getDisplayText()}
        </span>
        <ChevronDown 
          className={`cyber-dropdown-arrow ${isOpen ? 'cyber-dropdown-arrow-open' : ''}`}
          size={16}
        />
        <div className="cyber-dropdown-glow"></div>
      </div>

      <animated.div 
        style={menuAnimation}
        className="cyber-dropdown-menu"
      >
        {searchable && (
          <div className="cyber-dropdown-search">
            <input
              ref={searchInputRef}
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search options..."
              className="cyber-dropdown-search-input"
            />
          </div>
        )}
        
        <div className="cyber-dropdown-options">
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => (
              <div
                key={option.value}
                className={`cyber-dropdown-option ${isSelected(option.value) ? 'cyber-dropdown-option-selected' : ''}`}
                onClick={() => handleOptionSelect(option)}
                role="option"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleOptionSelect(option);
                  }
                }}
              >
                <span className="cyber-dropdown-option-label">
                  {option.label}
                </span>
                {option.description && (
                  <span className="cyber-dropdown-option-description">
                    {option.description}
                  </span>
                )}
                {isSelected(option.value) && (
                  <Check className="cyber-dropdown-option-check" size={16} />
                )}
                <div className="cyber-dropdown-option-glow"></div>
              </div>
            ))
          ) : (
            <div className="cyber-dropdown-no-options">
              No options found
            </div>
          )}
        </div>
      </animated.div>
    </div>
  );
};

export default CyberDropdown;