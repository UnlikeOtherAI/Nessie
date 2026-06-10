/**
 * web/src/Workflow.tsx — Basic workflow management UI.
 * DAG visualization can be added later with @antv/x6 integration.
 */

import React, { useState, useEffect } from 'react'

interface Workflow {
  id: string
  name: string
  description: string
  status: string
  ownerAgentId: string
  taskIds: string[]
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

interface Task {
  id: string
  workflowId: string
  label: string
  description: string
  status: string
  ownerAgentId: string | null
  dependencies: string[]
  result: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

const API_BASE = ''

export function WorkflowApp() {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Create workflow form state
  const [showCreate, setShowCreate] = useState(false)
  const [newWorkflowName, setNewWorkflowName] = useState('')
  const [newWorkflowDesc, setNewWorkflowDesc] = useState('')

  // Create task form state
  const [showCreateTask, setShowCreateTask] = useState(false)
  const [newTaskLabel, setNewTaskLabel] = useState('')
  const [newTaskDesc, setNewTaskDesc] = useState('')

  useEffect(() => {
    fetchWorkflows()
  }, [])

  async function fetchWorkflows() {
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/workflow`)
      const data = await res.json()
      setWorkflows(data.workflows || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch workflows')
    } finally {
      setLoading(false)
    }
  }

  async function fetchWorkflowTasks(workflowId: string) {
    try {
      const res = await fetch(`${API_BASE}/workflow/get?workflowId=${workflowId}`)
      const data = await res.json()
      setSelectedWorkflow(data.workflow)
      setTasks(data.tasks || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch tasks')
    }
  }

  async function createWorkflow(e: React.FormEvent) {
    e.preventDefault()
    if (!newWorkflowName.trim()) return
    try {
      const res = await fetch(`${API_BASE}/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newWorkflowName, description: newWorkflowDesc }),
      })
      if (!res.ok) throw new Error('Failed to create workflow')
      setNewWorkflowName('')
      setNewWorkflowDesc('')
      setShowCreate(false)
      fetchWorkflows()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workflow')
    }
  }

  async function createTask(e: React.FormEvent) {
    e.preventDefault()
    if (!newTaskLabel.trim() || !selectedWorkflow) return
    try {
      const res = await fetch(`${API_BASE}/workflow/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: selectedWorkflow.id,
          label: newTaskLabel,
          description: newTaskDesc,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create task')
      }
      setNewTaskLabel('')
      setNewTaskDesc('')
      setShowCreateTask(false)
      fetchWorkflowTasks(selectedWorkflow.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task')
    }
  }

  async function completeTask(taskId: string, status: 'completed' | 'failed', error?: string) {
    try {
      await fetch(`${API_BASE}/workflow/task/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, status, error }),
      })
      if (selectedWorkflow) {
        fetchWorkflowTasks(selectedWorkflow.id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete task')
    }
  }

  function getStatusColor(status: string): string {
    switch (status) {
      case 'pending': return 'var(--status-pending)'
      case 'in_progress': return 'var(--status-in-progress)'
      case 'completed': return 'var(--status-completed)'
      case 'failed': return 'var(--status-failed)'
      default: return 'var(--status-pending)'
    }
  }

  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Workflow Management</h1>

      {error && (
        <div
          style={{
            padding: '10px',
            background: 'var(--danger-soft)',
            color: 'var(--danger-text)',
            borderRadius: '4px',
            marginBottom: '10px',
          }}
        >
          {error}
          <button onClick={() => setError(null)} style={{ marginLeft: '10px' }}>Dismiss</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: '20px' }}>
        {/* Workflow List */}
        <div style={{ flex: 1 }}>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}
          >
            <h2>Workflows</h2>
            <button onClick={() => setShowCreate(true)}>New Workflow</button>
          </div>

          {showCreate && (
            <form
      onSubmit={createWorkflow}
      style={{ padding: '10px', background: 'var(--surface-soft)', borderRadius: '4px', marginBottom: '10px' }}
    >
              <input
                type="text"
                placeholder="Workflow name"
                value={newWorkflowName}
                onChange={(e) => setNewWorkflowName(e.target.value)}
                style={{ display: 'block', width: '100%', marginBottom: '5px', padding: '5px' }}
              />
              <textarea
                placeholder="Description (optional)"
                value={newWorkflowDesc}
                onChange={(e) => setNewWorkflowDesc(e.target.value)}
                style={{ display: 'block', width: '100%', marginBottom: '5px', padding: '5px' }}
              />
              <button type="submit">Create</button>
              <button type="button" onClick={() => setShowCreate(false)} style={{ marginLeft: '5px' }}>Cancel</button>
            </form>
          )}

          {loading ? (
            <p>Loading...</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {workflows.map((wf) => (
                <li
                  key={wf.id}
                  style={{ padding: '10px', borderBottom: '1px solid var(--border-soft)', cursor: 'pointer' }}
                >
                  <div
                    style={{ fontWeight: selectedWorkflow?.id === wf.id ? 'bold' : 'normal' }}
                    onClick={() => fetchWorkflowTasks(wf.id)}
                  >
                    <span style={{ marginRight: '10px' }}>{wf.name}</span>
                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{wf.status}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Task List */}
        {selectedWorkflow && (
          <div style={{ flex: 2 }}>
            <div
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}
          >
              <h2>Tasks: {selectedWorkflow.name}</h2>
              <button onClick={() => setShowCreateTask(true)}>Add Task</button>
            </div>

            {showCreateTask && (
              <form
              onSubmit={createTask}
              style={{ padding: '10px', background: 'var(--surface-soft)', borderRadius: '4px', marginBottom: '10px' }}
            >
                <input
                  type="text"
                  placeholder="Task label"
                  value={newTaskLabel}
                  onChange={(e) => setNewTaskLabel(e.target.value)}
                  style={{ display: 'block', width: '100%', marginBottom: '5px', padding: '5px' }}
                />
                <textarea
                  placeholder="Description (optional)"
                  value={newTaskDesc}
                  onChange={(e) => setNewTaskDesc(e.target.value)}
                  style={{ display: 'block', width: '100%', marginBottom: '5px', padding: '5px' }}
                />
                <button type="submit">Create</button>
                <button
              type="button"
              onClick={() => setShowCreateTask(false)}
              style={{ marginLeft: '5px' }}
            >
              Cancel
            </button>
              </form>
            )}

            {tasks.length === 0 ? (
              <p>No tasks yet. Create one to get started.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {tasks.map((task) => (
                  <li key={task.id} style={{ padding: '10px', borderBottom: '1px solid var(--border-soft)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span
                        style={{
                          width: '10px',
                          height: '10px',
                          borderRadius: '50%',
                          background: getStatusColor(task.status),
                        }}
                      />
                      <strong>{task.label}</strong>
                      <span style={{ fontSize: '12px', color: 'var(--muted)' }}>({task.status})</span>
                    </div>
                    {task.description && <p style={{ margin: '5px 0', color: 'var(--muted)' }}>{task.description}</p>}
                    {task.error && <p style={{ margin: '5px 0', color: 'var(--danger)' }}>Error: {task.error}</p>}
                    {task.dependencies.length > 0 && (
                      <p style={{ margin: '5px 0', fontSize: '12px', color: 'var(--muted)' }}>
                        Depends on: {task.dependencies.join(', ')}
                      </p>
                    )}
                    {task.status === 'pending' && (
                      <div style={{ marginTop: '5px' }}>
                        <button onClick={() => completeTask(task.id, 'completed')}>Mark Complete</button>
                        <button onClick={() => completeTask(task.id, 'failed', 'Manual failure')}>Mark Failed</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* DAG Visualization placeholder */}
            <div
            style={{
              marginTop: '20px',
              padding: '20px',
              background: 'var(--surface)',
              borderRadius: '4px',
              textAlign: 'center',
            }}
          >
              <p style={{ color: 'var(--muted)' }}>
                DAG visualization available at <code>/workflow</code> endpoint
              </p>
              <p style={{ fontSize: '12px', color: 'var(--muted)' }}>
                (Full @antv/x6 visualization coming soon)
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
