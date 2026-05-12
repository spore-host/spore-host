# Spore.host Web Interface

Landing page and future web dashboard for managing spores (EC2 instances).

## 📁 Structure

```
web/
├── index.html          # Landing page
├── dashboard.html      # Dashboard page
├── css/
│   └── style.css      # Spore-themed styling
├── js/
│   └── main.js        # Interactive features & API client
└── README.md          # This file
```

## 🎨 Current Features

### Landing Page
- Hero section with adaptive logo
- Installation instructions (Homebrew, Scoop, Manual)
- Feature showcase for Truffle, Spawn, Spored
- Key features grid
- Usage examples
- Coming Soon section for web dashboard

### Design
- Dark theme with bioluminescent glow effects
- Spore-inspired color palette (blues and greens)
- Responsive design for mobile/tablet/desktop
- Smooth animations and transitions
- OS-aware default installation tab

## 🚀 Future: Web Dashboard

The landing page is designed to evolve into a full management dashboard:

### Planned Features

#### 1. Instance Management
- **List View**: All provisioned spores across regions
- **Detail View**: Individual instance information
- **Controls**: Start, stop, terminate, extend TTL
- **Bulk Actions**: Manage multiple instances at once

#### 2. Monitoring
- **Real-Time Metrics**: CPU, network, disk I/O, GPU utilization
- **Graphs**: Historical performance data via CloudWatch
- **Alerts**: Notifications for high usage or approaching TTL
- **Cost Tracking**: Running costs per instance and totals

#### 3. Web SSH
- **Browser-based Terminal**: Connect via AWS Session Manager
- **Key Management**: Upload and manage SSH keys
- **Multi-Tab**: Connect to multiple instances simultaneously
- **Copy/Paste**: Full clipboard support

#### 4. Remote Desktop (NICE DCV)
- **Graphical Access**: Full desktop for GPU workloads
- **Low Latency**: Optimized streaming protocol
- **Multi-Monitor**: Support for multiple displays
- **File Transfer**: Drag-and-drop file sharing

#### 5. Settings & Configuration
- **Preferences**: Default regions, instance types, TTLs
- **Credentials**: AWS profile management
- **Quotas**: View and request quota increases
- **Notifications**: Email/Slack alerts

#### 6. Team Features (Future)
- **Multi-User**: Shared instance management
- **Permissions**: Role-based access control
- **Audit Log**: Track all actions
- **Cost Allocation**: Per-user or per-team billing

## 🏗️ Architecture

### Current (Static Landing Page)
```
User → CloudFront → S3 (static site)
```

### Future (Full Dashboard)
```
User → CloudFront → S3 (static UI)
                  ↓
                API Gateway
                  ↓
        ┌─────────┴─────────┐
        ↓                   ↓
    Lambda (API)     Lambda (WebSocket)
        ↓                   ↓
        ↓            Real-time Updates
        ↓
    ┌───┴───┐
    ↓       ↓
   EC2     DynamoDB
  (AWS)   (State)
```

### Technology Stack (Planned)
- **Frontend**: Vanilla JS → React (when needed)
- **Backend**: AWS Lambda (Node.js or Python)
- **API**: API Gateway (REST + WebSocket)
- **Auth**: Cognito or IAM-based
- **Storage**: DynamoDB for state, S3 for assets
- **Real-time**: WebSockets for live metrics
- **SSH**: AWS Session Manager + WebSocket proxy
- **DCV**: NICE DCV Web Client SDK

## 📋 Deployment

### Option 1: S3 + CloudFront (Recommended)

```bash
# 1. Create S3 bucket for website
aws s3 mb s3://spore-host-website --region us-east-1

# 2. Enable static website hosting
aws s3 website s3://spore-host-website \
    --index-document index.html \
    --error-document index.html

# 3. Upload website files
aws s3 sync web/ s3://spore-host-website/ \
    --delete \
    --acl public-read

# 4. Create CloudFront distribution (see DEPLOYMENT.md)

# 5. Point spore.host DNS to CloudFront
# Update Route53 A record to CloudFront distribution
```

### Option 2: GitHub Pages (Simple)

```bash
# 1. Push web/ directory to gh-pages branch
git subtree push --prefix web origin gh-pages

# 2. Configure custom domain in repository settings
# Settings → Pages → Custom domain: spore.host

# 3. Update DNS
# Add CNAME record: spore.host → spore-host.github.io
```

### Option 3: Local Testing

```bash
# Simple HTTP server
cd web
python3 -m http.server 8000

# Visit: http://localhost:8000
```

## 🔐 Security Considerations

### Current (Static Site)
- Read-only content
- No user data
- No authentication needed

### Future (Dashboard)
- **Authentication**: AWS Cognito or IAM credentials
- **Authorization**: Instance ownership verification
- **Encryption**: TLS for all traffic, encrypted WebSockets
- **API Keys**: Scoped permissions per user
- **Audit Logging**: Track all management actions
- **CORS**: Proper origin restrictions
- **CSP**: Content Security Policy headers
- **Rate Limiting**: Prevent API abuse

## 🎯 Implementation Phases

### Phase 1: Landing Page ✅ (Current)
- Static HTML/CSS/JS
- Installation instructions
- Feature showcase
- Examples and documentation links

### Phase 2: Read-Only Dashboard (Next)
- List instances across regions
- View instance details
- Display metrics (via CloudWatch API)
- No control actions yet

### Phase 3: Instance Control
- Start/stop/terminate actions
- Extend TTL
- SSH key management
- Basic cost tracking

### Phase 4: Web SSH
- AWS Session Manager integration
- Browser-based terminal
- Multi-instance tabs

### Phase 5: Monitoring & Alerts
- Real-time metrics via WebSocket
- Historical graphs
- Custom alerts
- Cost notifications

### Phase 6: Remote Desktop
- NICE DCV integration
- Graphical desktop access
- File transfer
- Multi-monitor support

### Phase 7: Team Features
- Multi-user support
- Permissions and roles
- Shared instances
- Team billing

## 📝 API Design (Future)

### REST Endpoints
```
GET    /api/instances              List all instances
GET    /api/instances/:id          Get instance details
POST   /api/instances              Launch new instance
PATCH  /api/instances/:id          Update instance (extend TTL)
DELETE /api/instances/:id          Terminate instance
GET    /api/instances/:id/metrics  Get CloudWatch metrics
POST   /api/instances/:id/start    Start stopped instance
POST   /api/instances/:id/stop     Stop running instance
GET    /api/instances/:id/ssh      Get SSH connection info
POST   /api/instances/:id/session  Create Session Manager session
```

### WebSocket Events
```
subscribe:instance:metrics   Real-time CPU/network/disk/GPU
subscribe:instance:logs      Tail instance logs
subscribe:instance:state     State changes (running/stopped/terminated)
notify:ttl:warning          TTL expiring soon
notify:quota:limit          Approaching quota limit
```

## 🧪 Testing

### Current
```bash
# Visual regression testing (manual)
open web/index.html

# Responsive testing
# Use browser dev tools to test mobile/tablet views
```

### Future
```bash
# Unit tests
npm test

# E2E tests
npm run test:e2e

# API tests
npm run test:api
```

## 📊 Analytics (Future)

Consider adding:
- Google Analytics or Plausible for page views
- Error tracking (Sentry)
- Performance monitoring (Lighthouse CI)
- User feedback widget

## 🤝 Contributing

When adding features to the web interface:

1. Keep mobile-first responsive design
2. Maintain spore theme (dark + glow)
3. Add loading states for all async operations
4. Include error handling and user feedback
5. Test across browsers (Chrome, Firefox, Safari, Edge)
6. Update this README with new features

## 📚 Resources

- [AWS Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)
- [NICE DCV Web Client SDK](https://docs.aws.amazon.com/dcv/latest/adminguide/client-web.html)
- [API Gateway WebSocket APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api.html)
- [CloudWatch Metrics](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/working_with_metrics.html)

## 🔮 Vision

Transform `spore.host` from a CLI-first tool into a hybrid experience:
- **CLI**: Fast, scriptable, power-user focused
- **Web**: Visual, intuitive, accessible to everyone
- **Both**: Use whichever fits your workflow

The web interface should feel like a natural extension of the CLI, not a replacement. Power users can script with spawn/truffle, beginners can click through the web UI, and everyone can monitor their spores from anywhere.
