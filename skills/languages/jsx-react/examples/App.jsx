import React, { useState, useCallback, useMemo } from 'react';

// Custom Hook
function usePipelineItems(initialItems = []) {
  const [items, setItems] = useState(initialItems);

  const addItem = useCallback((name) => {
    if (!name.trim()) return;
    const newItem = {
      id: 'item_' + Date.now(),
      name: name.trim(),
      timestamp: new Date().toLocaleTimeString()
    };
    setItems(prev => [newItem, ...prev]);
  }, []);

  const removeItem = useCallback((id) => {
    setItems(prev => prev.filter(item => item.id !== id));
  }, []);

  return { items, addItem, removeItem };
}

// Pure Presentational Component
const ItemCard = React.memo(({ item, onDelete }) => {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '0.75rem 1rem',
      background: 'rgba(255, 255, 255, 0.05)',
      borderRadius: '8px',
      marginBottom: '0.5rem',
      border: '1px solid rgba(255, 255, 255, 0.1)'
    }}>
      <div>
        <strong style={{ color: '#f8fafc' }}>{item.name}</strong>
        <span style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8' }}>
          Added at {item.timestamp}
        </span>
      </div>
      <button 
        onClick={() => onDelete(item.id)}
        style={{
          background: '#ef4444',
          color: '#fff',
          border: 'none',
          padding: '0.4rem 0.8rem',
          borderRadius: '6px',
          cursor: 'pointer'
        }}
      >
        Delete
      </button>
    </div>
  );
});

export default function App() {
  const [inputValue, setInputValue] = useState('');
  const { items, addItem, removeItem } = usePipelineItems([
    { id: 'item_1', name: 'Starter React 18 Pipeline', timestamp: '12:00:00 PM' }
  ]);

  const handleSubmit = (e) => {
    e.preventDefault();
    addItem(inputValue);
    setInputValue('');
  };

  const totalCount = useMemo(() => items.length, [items]);

  return (
    <div style={{
      maxWidth: '650px',
      margin: '2rem auto',
      padding: '2rem',
      background: '#1e293b',
      borderRadius: '12px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      fontFamily: 'system-ui, sans-serif'
    }}>
      <h1 style={{ color: '#6366f1', marginBottom: '0.5rem' }}>React 18 JSX Core Engine</h1>
      <p style={{ color: '#94a3b8', marginBottom: '1.5rem' }}>
        Total Active Items in State: <strong>{totalCount}</strong>
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <input 
          type="text" 
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Enter component item name..."
          style={{
            flex: 1,
            padding: '0.75rem',
            borderRadius: '6px',
            border: '1px solid #475569',
            background: '#0f172a',
            color: '#fff'
          }}
        />
        <button 
          type="submit"
          style={{
            padding: '0.75rem 1.25rem',
            background: '#6366f1',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            fontWeight: '600',
            cursor: 'pointer'
          }}
        >
          Add Item
        </button>
      </form>

      <div>
        {items.map(item => (
          <ItemCard key={item.id} item={item} onDelete={removeItem} />
        ))}
      </div>
    </div>
  );
}
