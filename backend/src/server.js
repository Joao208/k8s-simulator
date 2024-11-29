import express from 'express'
import dotenv from 'dotenv'
import { execa } from 'execa'
import { customAlphabet } from 'nanoid'
import cookieParser from 'cookie-parser'
import cron from 'node-cron'
import fs from 'fs/promises'

dotenv.config()

const app = express()
const router = express.Router()
app.use(express.json())
app.use(cookieParser())

const SANDBOX_LIFETIME_MS = 60 * 60 * 1000
const sandboxes = new Map()
const creationLocks = new Map()
const generateId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10)

async function cleanupExpiredSandboxes() {
  const now = Date.now()
  let cleanedCount = 0

  for (const [sandboxId, createdAt] of sandboxes.entries()) {
    if (now - createdAt > SANDBOX_LIFETIME_MS) {
      try {
        await deleteCluster(sandboxId)
        sandboxes.delete(sandboxId)
        cleanedCount++
      } catch (error) {
        console.error(`Failed to cleanup sandbox ${sandboxId}:`, error)
      }
    }
  }
}

cron.schedule('*/5 * * * *', cleanupExpiredSandboxes, {
  scheduled: true,
  timezone: 'UTC',
})

async function createCluster(sandboxId) {
  try {
    const config = `
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: ${sandboxId}
nodes:
- role: control-plane
  extraPortMappings:
  - containerPort: 80
    hostPort: 0
    protocol: TCP
`
    const configPath = `/tmp/${sandboxId}-config.yaml`
    await fs.writeFile(configPath, config)

    await execa('kind', ['create', 'cluster', '--config', configPath])

    await fs.unlink(configPath)

    sandboxes.set(sandboxId, Date.now())
    return true
  } catch (error) {
    throw new Error(`Failed to create cluster: ${error.message}`)
  }
}

async function deleteCluster(sandboxId) {
  try {
    await execa('kind', ['delete', 'cluster', '--name', sandboxId])
    sandboxes.delete(sandboxId)
  } catch (error) {
    throw new Error(`Failed to delete cluster: ${error.message}`)
  }
}

function preventConcurrentRequests(req, res, next) {
  const clientIp = req.ip

  if (creationLocks.get(clientIp)) {
    return res.status(429).json({
      error: 'A sandbox is already being created for this IP. Please wait.',
    })
  }

  creationLocks.set(clientIp, true)
  res.on('finish', () => {
    creationLocks.delete(clientIp)
  })

  next()
}

async function validateSandbox(req, res, next) {
  const sandboxId = req.cookies.sandboxId

  if (!sandboxId) {
    return res
      .status(401)
      .json({ error: 'Sandbox not found. Create a new sandbox first.' })
  }

  try {
    await execa('k3d', ['cluster', 'list', sandboxId])
    next()
  } catch (error) {
    res.clearCookie('sandboxId')
    sandboxes.delete(sandboxId)
    return res.status(404).json({ error: 'Sandbox not found or expired.' })
  }
}

async function executeKubectlCommand(sandboxId, command) {
  const args = command.split(' ')
  try {
    const result = await execa('kubectl', [
      '--context',
      `kind-${sandboxId}`,
      ...args,
    ])
    return result.stdout
  } catch (error) {
    throw new Error(`Error executing command: ${error.message}`)
  }
}

router.post('/sandbox', preventConcurrentRequests, async (req, res) => {
  try {
    const existingSandboxId = req.cookies.sandboxId
    if (existingSandboxId) {
      try {
        await execa('k3d', ['cluster', 'list', existingSandboxId])
        return res.json({
          message: 'Using existing sandbox',
          sandboxId: existingSandboxId,
          expiresIn: `${SANDBOX_LIFETIME_MS / 1000 / 60} minutes`,
        })
      } catch (error) {
        res.clearCookie('sandboxId')
        sandboxes.delete(existingSandboxId)
      }
    }

    const sandboxId = 'sb-' + generateId()
    await createCluster(sandboxId)

    res.cookie('sandboxId', sandboxId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: SANDBOX_LIFETIME_MS,
    })

    res.json({
      message: 'Sandbox created successfully',
      sandboxId,
      expiresIn: `${SANDBOX_LIFETIME_MS / 1000 / 60} minutes`,
    })
  } catch (error) {
    console.error('Error creating sandbox:', error)
    res.status(500).json({ error: error.message })
  }
})

router.post('/sandbox/exec', validateSandbox, async (req, res) => {
  try {
    const { command } = req.body
    const sandboxId = req.cookies.sandboxId

    if (!command) {
      return res.status(400).json({ error: 'Command not provided' })
    }

    const result = await executeKubectlCommand(sandboxId, command)

    res.json({
      message: 'Command executed successfully',
      command,
      output: result.stdout,
    })
  } catch (error) {
    console.error('Error executing command:', error)
    res.status(500).json({ error: error.message })
  }
})

router.delete('/sandbox', validateSandbox, async (req, res) => {
  try {
    const sandboxId = req.cookies.sandboxId
    await deleteCluster(sandboxId)
    res.clearCookie('sandboxId')
    res.json({
      message: 'Sandbox deleted successfully',
    })
  } catch (error) {
    console.error('Error deleting sandbox:', error)
    res.status(500).json({ error: error.message })
  }
})

app.use('/api', router)

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
