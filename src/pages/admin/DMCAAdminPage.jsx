import React, { useState, useEffect } from 'react';
import { useSupabase } from '../../context/SupabaseContext';
import { toast } from 'sonner';
import './DMCAAdminPage.css';

function DMCAAdminPage() {
  const { supabase } = useSupabase();
  const [takedowns, setTakedowns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTakedown, setSelectedTakedown] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    loadTakedowns();
  }, [statusFilter]);

  const loadTakedowns = async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('dmca_takedowns')
        .select('*')
        .order('created_at', { ascending: false });

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      }

      const { data, error } = await query;

      if (error) throw error;

      setTakedowns(data || []);
    } catch (error) {
      console.error('[DMCA Admin] Failed to load takedowns:', error);
      toast.error('Failed to load DMCA takedowns');
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (id, newStatus, adminNotes = '') => {
    try {
      const { error } = await supabase
        .from('dmca_takedowns')
        .update({ 
          status: newStatus,
          admin_notes: adminNotes,
          actioned_at: new Date().toISOString()
        })
        .eq('id', id);

      if (error) throw error;

      toast.success(`Status updated to: ${newStatus}`);
      loadTakedowns();
      setSelectedTakedown(null);
    } catch (error) {
      console.error('[DMCA Admin] Failed to update status:', error);
      toast.error('Failed to update status');
    }
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString();
  };

  const getStatusBadge = (status) => {
    const badges = {
      open: { color: '#ffaa33', label: 'Open' },
      actioned: { color: '#00ffff', label: 'Actioned' },
      closed: { color: '#4ade80', label: 'Closed' }
    };
    const badge = badges[status] || badges.open;
    return (
      <span className="status-badge" style={{ color: badge.color }}>
        {badge.label}
      </span>
    );
  };

  return (
    <div className="dmca-admin-page">
      <div className="dmca-admin-container">
        <div className="dmca-admin-header">
          <h1>DMCA Takedown Administration</h1>
          <div className="filters">
            <label>Filter by status:</label>
            <select 
              value={statusFilter} 
              onChange={(e) => setStatusFilter(e.target.value)}
              className="filter-select"
            >
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="actioned">Actioned</option>
              <option value="closed">Closed</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="loading">Loading takedowns...</div>
        ) : takedowns.length === 0 ? (
          <div className="empty-state">
            <p>No DMCA takedowns found</p>
          </div>
        ) : (
          <div className="takedowns-grid">
            {takedowns.map((takedown) => (
              <div key={takedown.id} className="takedown-card">
                <div className="takedown-header">
                  <div>
                    <strong>{takedown.complainant_name}</strong>
                    {getStatusBadge(takedown.status)}
                  </div>
                  <small>{formatDate(takedown.created_at)}</small>
                </div>

                <div className="takedown-body">
                  <div className="field">
                    <label>Email:</label>
                    <span>{takedown.complainant_email}</span>
                  </div>

                  {takedown.rights_holder && (
                    <div className="field">
                      <label>Rights Holder:</label>
                      <span>{takedown.rights_holder}</span>
                    </div>
                  )}

                  <div className="field">
                    <label>Infringing URLs ({takedown.infringing_urls?.length || 0}):</label>
                    <ul className="url-list">
                      {(takedown.infringing_urls || []).map((url, idx) => (
                        <li key={idx}>
                          <a href={url} target="_blank" rel="noopener noreferrer">
                            {url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="field">
                    <label>Original Work URLs ({takedown.original_work_urls?.length || 0}):</label>
                    <ul className="url-list">
                      {(takedown.original_work_urls || []).map((url, idx) => (
                        <li key={idx}>
                          <a href={url} target="_blank" rel="noopener noreferrer">
                            {url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {takedown.evidence_urls && takedown.evidence_urls.length > 0 && (
                    <div className="field">
                      <label>Evidence URLs:</label>
                      <ul className="url-list">
                        {takedown.evidence_urls.map((url, idx) => (
                          <li key={idx}>
                            <a href={url} target="_blank" rel="noopener noreferrer">
                              {url}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="field">
                    <label>Sworn Statement:</label>
                    <p className="statement">{takedown.sworn_statement}</p>
                  </div>

                  <div className="field">
                    <label>Signature:</label>
                    <span className="signature">{takedown.signature}</span>
                  </div>

                  {takedown.admin_notes && (
                    <div className="field admin-notes">
                      <label>Admin Notes:</label>
                      <p>{takedown.admin_notes}</p>
                    </div>
                  )}
                </div>

                <div className="takedown-actions">
                  <button 
                    className="btn-action"
                    onClick={() => setSelectedTakedown(takedown)}
                  >
                    Update Status
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {selectedTakedown && (
          <div className="modal-overlay" onClick={() => setSelectedTakedown(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2>Update Takedown Status</h2>
              <p>ID: {selectedTakedown.id}</p>
              <p>Current Status: {getStatusBadge(selectedTakedown.status)}</p>

              <div className="modal-actions">
                <button 
                  className="btn-status btn-actioned"
                  onClick={() => updateStatus(selectedTakedown.id, 'actioned')}
                >
                  Mark as Actioned
                </button>
                <button 
                  className="btn-status btn-closed"
                  onClick={() => updateStatus(selectedTakedown.id, 'closed')}
                >
                  Mark as Closed
                </button>
                <button 
                  className="btn-status btn-open"
                  onClick={() => updateStatus(selectedTakedown.id, 'open')}
                >
                  Reopen
                </button>
                <button 
                  className="btn-cancel"
                  onClick={() => setSelectedTakedown(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default DMCAAdminPage;
