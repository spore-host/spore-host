// spore.host Landing Page - Interactive Features

// Accessibility: announce messages to screen readers via aria-live region
function announce(msg) {
    const el = document.getElementById('a11y-announcer');
    if (el) { el.textContent = ''; requestAnimationFrame(() => { el.textContent = msg; }); }
}

// Accessibility: modal focus management
let modalPreviousFocus = null;

function modalEscapeHandler(e) {
    if (e.key === 'Escape') closeTeamModal();
}

function trapFocusInModal(e) {
    const modal = document.getElementById('team-modal');
    if (!modal || modal.style.display === 'none') return;
    const focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.key === 'Tab') {
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
        }
    }
}

// Tab Switching for Install Instructions
function showTab(tabName, event) {
    const contents = document.querySelectorAll('.tab-content');
    contents.forEach(content => {
        content.classList.remove('active');
    });

    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(button => {
        button.classList.remove('active');
    });

    const selectedTab = document.getElementById(tabName);
    if (selectedTab) {
        selectedTab.classList.add('active');
    }

    const clickedButton = event?.target;
    if (clickedButton && clickedButton.classList) {
        clickedButton.classList.add('active');
    }
}

// Smooth Scrolling for Anchor Links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// Add Loading Animation to External Links
document.querySelectorAll('a[target="_blank"]').forEach(link => {
    link.addEventListener('click', function() {
        this.style.opacity = '0.7';
        setTimeout(() => {
            this.style.opacity = '1';
        }, 300);
    });
});

// Detect OS and Set Default Tab
function setDefaultInstallTab() {
    const userAgent = navigator.userAgent.toLowerCase();
    let defaultTab = 'homebrew';

    if (userAgent.includes('win')) {
        defaultTab = 'scoop';
    }

    showTab(defaultTab);

    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(button => {
        button.classList.remove('active');
    });

    const activeButton = Array.from(buttons).find(btn =>
        (defaultTab === 'scoop' && btn.textContent.includes('Windows')) ||
        (defaultTab === 'homebrew' && btn.textContent.includes('macOS'))
    );

    if (activeButton) {
        activeButton.classList.add('active');
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    setDefaultInstallTab();

    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '0';
                entry.target.style.transform = 'translateY(20px)';
                entry.target.style.transition = 'all 0.6s ease';

                setTimeout(() => {
                    entry.target.style.opacity = '1';
                    entry.target.style.transform = 'translateY(0)';
                }, 100);

                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    document.querySelectorAll('.feature-card, .example, .preview-card').forEach(el => {
        observer.observe(el);
    });
});

// ═══════════════════════════════════════════════════════════════
// Theme System
// ═══════════════════════════════════════════════════════════════

function getChartColors() {
    const style = getComputedStyle(document.documentElement);
    return {
        grid:  style.getPropertyValue('--chart-grid').trim()  || 'rgba(255,255,255,0.07)',
        text:  style.getPropertyValue('--chart-text').trim()  || '#9aa0a6',
        empty: style.getPropertyValue('--chart-empty').trim() || 'rgba(255,255,255,0.08)',
    };
}

let currentCostDays = 30;

function toggleTheme() {
    const html = document.documentElement;
    const currentTheme = html.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

    html.classList.add('theme-transitioning');
    html.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    setTimeout(() => html.classList.remove('theme-transitioning'), 300);

    const icon = document.getElementById('theme-icon');
    if (icon) icon.textContent = newTheme === 'dark' ? '🌙' : '☀️';

    const toggleBtn = document.getElementById('theme-toggle');
    if (toggleBtn) toggleBtn.setAttribute('aria-label', newTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');

    // Re-render charts so colors adapt to new theme
    if (typeof loadCostChart === 'function' && (costTrendChart || costBreakdownChart)) {
        loadCostChart(currentCostDays);
    }
}

// Set icon once DOM is ready (data-theme already set by FOUC script in <head>)
document.addEventListener('DOMContentLoaded', function () {
    const savedTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const icon = document.getElementById('theme-icon');
    if (icon) icon.textContent = savedTheme === 'dark' ? '🌙' : '☀️';
});

// Follow system preference changes when user hasn't manually chosen
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function (e) {
    if (!localStorage.getItem('theme')) {
        const newTheme = e.matches ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', newTheme);
        const icon = document.getElementById('theme-icon');
        if (icon) icon.textContent = newTheme === 'dark' ? '🌙' : '☀️';
        if (typeof loadCostChart === 'function' && (costTrendChart || costBreakdownChart)) {
            loadCostChart(currentCostDays);
        }
    }
});

// Copy to Clipboard for Code Blocks
function addCopyButtons() {
    const codeBlocks = document.querySelectorAll('pre code');
    codeBlocks.forEach((block, index) => {
        const button = document.createElement('button');
        button.textContent = 'Copy';
        button.className = 'copy-btn';
        button.style.cssText = `
            position: absolute;
            top: 0.5rem;
            right: 0.5rem;
            padding: 0.3rem 0.8rem;
            background: var(--accent-blue);
            color: var(--bg-dark);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.85rem;
            opacity: 0;
            transition: opacity 0.3s ease;
        `;

        const pre = block.parentElement;
        pre.style.position = 'relative';
        pre.appendChild(button);

        pre.addEventListener('mouseenter', () => {
            button.style.opacity = '1';
        });

        pre.addEventListener('mouseleave', () => {
            button.style.opacity = '0';
        });

        button.addEventListener('click', () => {
            navigator.clipboard.writeText(block.textContent).then(() => {
                button.textContent = 'Copied!';
                setTimeout(() => {
                    button.textContent = 'Copy';
                }, 2000);
            });
        });
    });
}

if (navigator.clipboard) {
    document.addEventListener('DOMContentLoaded', addCopyButtons);
}

// ═══════════════════════════════════════════════════════════════
// Dashboard - Client-Side EC2 Queries
// ═══════════════════════════════════════════════════════════════

// Helper function to create API request headers with AWS credentials
function getAPIHeaders() {
    const headers = {
        'Content-Type': 'application/json'
    };

    // Add AWS credentials for authentication
    if (AWS && AWS.config && AWS.config.credentials) {
        const creds = {
            accessKeyId: AWS.config.credentials.accessKeyId,
            secretAccessKey: AWS.config.credentials.secretAccessKey,
            sessionToken: AWS.config.credentials.sessionToken
        };
        headers['X-AWS-Credentials'] = btoa(JSON.stringify(creds));
        console.log('✓ Added AWS credentials to request headers');
    } else {
        console.warn('⚠ AWS credentials not available - request will fail');
        console.log('AWS:', typeof AWS);
        console.log('AWS.config:', typeof AWS?.config);
        console.log('AWS.config.credentials:', AWS?.config?.credentials);
    }

    // Add user email for web user identity mapping
    if (typeof authManager !== 'undefined') {
        const user = authManager.getUser();
        if (user && user.email) {
            headers['X-User-Email'] = user.email;
            console.log('✓ Added user email to request headers');
        }
    }

    // Add team context if selected
    const selectedTeamId = sessionStorage.getItem('selectedTeamId');
    if (selectedTeamId) {
        headers['X-Team-ID'] = selectedTeamId;
    }

    return headers;
}

// AWS regions to query
const AWS_REGIONS = [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-west-2', 'eu-central-1',
    'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1'
];

// Dashboard API - Client-Side EC2 queries using user's AWS credentials
const DashboardAPI = {
    // Cross-account role ARN (development account where instances live)
    crossAccountRoleArn: 'arn:aws:iam::435415984226:role/SpawnDashboardCrossAccountReadRole',
    crossAccountCredentials: null,

    // Assume cross-account role to access EC2 instances in development account
    async assumeCrossAccountRole() {
        if (this.crossAccountCredentials && this.crossAccountCredentials.expiration > Date.now()) {
            return this.crossAccountCredentials;
        }

        const sts = new AWS.STS();
        const data = await sts.assumeRole({
            RoleArn: this.crossAccountRoleArn,
            RoleSessionName: 'spawn-dashboard-session',
            DurationSeconds: 3600
        }).promise();

        this.crossAccountCredentials = {
            accessKeyId: data.Credentials.AccessKeyId,
            secretAccessKey: data.Credentials.SecretAccessKey,
            sessionToken: data.Credentials.SessionToken,
            expiration: data.Credentials.Expiration.getTime()
        };

        return this.crossAccountCredentials;
    },

    // List instances across all regions (parallel queries)
    async listInstances() {
        if (!AWS.config.credentials) {
            throw new Error('AWS credentials not configured');
        }

        // Check if user authenticated via GitHub (credentials already have cross-account access)
        const user = authManager.getUser();
        const isGitHubAuth = user && user.provider === 'github';

        // Only assume cross-account role for non-GitHub auth (Google, Globus)
        // GitHub Lambda already provides cross-account credentials
        if (!isGitHubAuth) {
            await this.assumeCrossAccountRole();
        }

        const results = await Promise.allSettled(
            AWS_REGIONS.map(region => this.listInstancesInRegion(region))
        );

        // Combine all successful results
        const allInstances = [];
        results.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                allInstances.push(...result.value);
            }
        });

        // Sort by launch time (newest first)
        allInstances.sort((a, b) => new Date(b.launch_time) - new Date(a.launch_time));

        return {
            success: true,
            regions_queried: AWS_REGIONS,
            total_instances: allInstances.length,
            instances: allInstances
        };
    },

    // List instances in a specific region
    async listInstancesInRegion(region) {
        // Check if user authenticated via GitHub
        const user = authManager.getUser();
        const isGitHubAuth = user && user.provider === 'github';

        // GitHub: use existing credentials (already cross-account)
        // Others: use cross-account credentials from STS AssumeRole
        const credentials = isGitHubAuth
            ? AWS.config.credentials
            : new AWS.Credentials({
                accessKeyId: this.crossAccountCredentials.accessKeyId,
                secretAccessKey: this.crossAccountCredentials.secretAccessKey,
                sessionToken: this.crossAccountCredentials.sessionToken
            });

        const ec2 = new AWS.EC2({
            region: region,
            credentials: credentials
        });

        // Query EC2 with filters (only show instances launched via spawn CLI)
        const params = {
            Filters: [
                { Name: 'tag:spawn:created-by', Values: ['spawn'] }
            ]
        };

        const data = await ec2.describeInstances(params).promise();

        // Convert to instance list
        const instances = [];
        data.Reservations.forEach(reservation => {
            reservation.Instances.forEach(instance => {
                instances.push(this.convertInstance(instance, region));
            });
        });

        return instances;
    },

    // Convert EC2 instance to dashboard format
    convertInstance(instance, region) {
        const tags = {};
        (instance.Tags || []).forEach(tag => {
            tags[tag.Key] = tag.Value;
        });

        // Parse state transition reason to get termination time
        let terminationTime = null;
        if (instance.State.Name === 'terminated' && instance.StateTransitionReason) {
            // Format: "User initiated (2026-01-15 01:30:45 GMT)"
            const match = instance.StateTransitionReason.match(/\(([^)]+)\)/);
            if (match) {
                try {
                    terminationTime = new Date(match[1]);
                } catch (e) {
                    // Ignore parsing errors
                }
            }
        }

        return {
            instance_id: instance.InstanceId,
            name: tags['Name'] || instance.InstanceId,
            instance_type: instance.InstanceType,
            state: instance.State.Name,
            region: region,
            availability_zone: instance.Placement.AvailabilityZone,
            public_ip: instance.PublicIpAddress || null,
            private_ip: instance.PrivateIpAddress || null,
            launch_time: instance.LaunchTime,
            termination_time: terminationTime,
            ttl: tags['spawn:ttl'] || null,
            dns_name: tags['spawn:dns-name'] || null,
            spot_instance: instance.InstanceLifecycle === 'spot',
            key_name: instance.KeyName || null,
            tags: tags
        };
    },

    // Get user account info
    async getUserProfile() {
        if (!AWS.config.credentials) {
            throw new Error('AWS credentials not configured');
        }

        const sts = new AWS.STS();
        const identity = await sts.getCallerIdentity().promise();

        // Also get cross-account identity
        let devAccountIdentity = null;
        try {
            await this.assumeCrossAccountRole();
            const devSts = new AWS.STS({
                credentials: new AWS.Credentials({
                    accessKeyId: this.crossAccountCredentials.accessKeyId,
                    secretAccessKey: this.crossAccountCredentials.secretAccessKey,
                    sessionToken: this.crossAccountCredentials.sessionToken
                })
            });
            devAccountIdentity = await devSts.getCallerIdentity().promise();
        } catch (error) {
            console.warn('Could not get dev account identity:', error);
        }

        return {
            success: true,
            user: {
                user_id: identity.Arn,
                aws_account_id: identity.Account,
                user_arn: identity.Arn,
                dev_account_id: devAccountIdentity?.Account || null
            }
        };
    }
};

// Dashboard UI Functions
async function loadDashboard() {
    const dashboardSection = document.getElementById('dashboard');
    if (!dashboardSection) return;

    try {
        const tbody = document.getElementById('instances-tbody');
        const errorDiv = document.getElementById('dashboard-error');
        const loadingDiv = document.getElementById('dashboard-loading');

        // Save expansion state BEFORE clearing tbody
        const expandedInstanceIds = new Set();
        if (tbody) {
            tbody.querySelectorAll('.instance-detail').forEach(detailRow => {
                if (detailRow.style.display === 'table-row') {
                    const instanceRow = detailRow.previousElementSibling;
                    if (instanceRow) {
                        const instanceId = instanceRow.getAttribute('data-instance-id');
                        if (instanceId) {
                            expandedInstanceIds.add(instanceId);
                        }
                    }
                }
            });
        }

        if (loadingDiv) loadingDiv.style.display = 'block';
        if (errorDiv) errorDiv.style.display = 'none';
        if (tbody) tbody.innerHTML = '';

        // Check AWS SDK
        if (typeof AWS === 'undefined') {
            throw new Error('AWS SDK not loaded. Please refresh the page.');
        }

        // Load instances
        const response = await DashboardAPI.listInstances();

        if (loadingDiv) loadingDiv.style.display = 'none';

        if (response.success && response.instances && response.instances.length > 0) {
            // Cache instances for filtering
            allInstancesCache = response.instances;

            // Populate region filter
            populateRegionFilter(response.instances);

            // Apply current filters
            applyTableFilters();
        } else {
            allInstancesCache = [];
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="7" style="text-align: center; padding: 3rem;">
                            <div style="max-width: 600px; margin: 0 auto;">
                                <div style="font-size: 3rem; margin-bottom: 1rem;">🍄</div>
                                <h3 style="color: var(--accent-blue); margin-bottom: 1rem;">No Spores Yet</h3>
                                <p style="color: var(--text-secondary); margin-bottom: 2rem; line-height: 1.8;">
                                    Spores are EC2 instances launched via the Spawn CLI. They'll appear here automatically once created.
                                </p>
                                <div style="background: rgba(79, 195, 247, 0.08); border: 1px solid rgba(79, 195, 247, 0.3); border-radius: 8px; padding: 1.5rem; text-align: left;">
                                    <h4 style="color: var(--accent-blue); margin-bottom: 1rem; text-align: center;">🚀 Quick Start</h4>
                                    <ol style="margin-left: 1.5rem; line-height: 2;">
                                        <li><strong>Install the CLI:</strong> <code style="background: var(--bg-dark); padding: 0.2rem 0.5rem; border-radius: 4px;">brew install scttfrdmn/tap/spawn</code></li>
                                        <li><strong>Launch your first spore:</strong> <code style="background: var(--bg-dark); padding: 0.2rem 0.5rem; border-radius: 4px;">spawn launch</code></li>
                                        <li><strong>Watch it appear here:</strong> Refresh this page in ~30 seconds</li>
                                    </ol>
                                    <p style="text-align: center; margin-top: 1.5rem; color: var(--text-muted); font-size: 0.9rem;">
                                        <a href="#install" style="color: var(--accent-blue); text-decoration: none;">View full installation guide ↓</a>
                                    </p>
                                </div>
                            </div>
                        </td>
                    </tr>
                `;
            }
        }
    } catch (error) {
        console.error('Failed to load dashboard:', error);

        if (loadingDiv) loadingDiv.style.display = 'none';

        if (errorDiv) {
            errorDiv.style.display = 'block';
            const errorMessage = error.message || 'Unknown error';

            if (errorMessage.includes('credentials') || errorMessage.includes('not authorized')) {
                errorDiv.innerHTML = `
                    <strong>⚠️ Authentication Required</strong><br>
                    Please configure your AWS credentials to view your instances.<br>
                    <small>Make sure your IAM user has EC2 read permissions.</small>
                `;
            } else {
                errorDiv.innerHTML = `<strong>Error:</strong> ${errorMessage}`;
            }
        }
    }
}

// Auto-refresh interval (30 seconds)
let dashboardRefreshInterval = null;

// Manual refresh function
async function refreshDashboard() {
    const btn = document.getElementById('refresh-btn');
    if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.textContent = '⏳ Refreshing...';
    }

    try {
        await refreshCurrentDashboardView();
        updateLastRefreshedTime();
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.textContent = '🔄 Refresh';
        }
    }
}

// Update last refreshed timestamp
function updateLastRefreshedTime() {
    const lastUpdated = document.getElementById('last-updated');
    if (lastUpdated) {
        const now = new Date();
        lastUpdated.textContent = `Last updated: ${now.toLocaleTimeString()}`;
    }
}

// Start auto-refresh
function startAutoRefresh() {
    // Clear any existing interval
    if (dashboardRefreshInterval) {
        clearInterval(dashboardRefreshInterval);
    }

    // Refresh every 30 seconds
    dashboardRefreshInterval = setInterval(async () => {
        console.log('Auto-refreshing dashboard...');
        await refreshCurrentDashboardView();
        updateLastRefreshedTime();
    }, 30000);

    console.log('Auto-refresh enabled (30s interval)');
}

// Stop auto-refresh (e.g., when user logs out)
function stopAutoRefresh() {
    if (dashboardRefreshInterval) {
        clearInterval(dashboardRefreshInterval);
        dashboardRefreshInterval = null;
        console.log('Auto-refresh disabled');
    }
}

function displayInstances(instances, expandedInstanceIds = new Set()) {
    const tbody = document.getElementById('instances-tbody');
    if (!tbody) return;

    // Group instances by job array ID
    const jobArrays = {};
    const standaloneInstances = [];

    instances.forEach(instance => {
        const jobArrayId = instance.tags['spawn:job-array-id'];
        if (jobArrayId) {
            if (!jobArrays[jobArrayId]) {
                jobArrays[jobArrayId] = {
                    id: jobArrayId,
                    name: instance.tags['spawn:job-array-name'] || jobArrayId,
                    size: parseInt(instance.tags['spawn:job-array-size']) || 0,
                    instances: []
                };
            }
            jobArrays[jobArrayId].instances.push(instance);
        } else {
            standaloneInstances.push(instance);
        }
    });

    // Sort job array instances by index
    Object.values(jobArrays).forEach(jobArray => {
        jobArray.instances.sort((a, b) => {
            const indexA = parseInt(a.tags['spawn:job-array-index']) || 0;
            const indexB = parseInt(b.tags['spawn:job-array-index']) || 0;
            return indexA - indexB;
        });
    });

    // Build list of instance IDs in order (for diffing)
    const newInstanceOrder = [];
    Object.values(jobArrays).forEach(jobArray => {
        jobArray.instances.forEach(instance => {
            newInstanceOrder.push(instance.instance_id);
        });
    });
    standaloneInstances.forEach(instance => {
        newInstanceOrder.push(instance.instance_id);
    });

    // Get current instance IDs
    const existingRows = Array.from(tbody.querySelectorAll('tr.instance-row'));
    const existingInstanceIds = existingRows.map(row => row.getAttribute('data-instance-id')).filter(id => id);

    // Check if structure changed (new/removed instances or reordering)
    const structureChanged =
        newInstanceOrder.length !== existingInstanceIds.length ||
        newInstanceOrder.some((id, i) => id !== existingInstanceIds[i]);

    // If structure changed, do full rebuild
    if (structureChanged) {
        // Build HTML
        let html = '';
        let globalIndex = 0;

        // Display job arrays first
        Object.values(jobArrays).forEach(jobArray => {
            const runningCount = jobArray.instances.filter(i => i.state === 'running').length;
            const terminatedCount = jobArray.instances.filter(i => i.state === 'terminated').length;
            const pendingCount = jobArray.instances.filter(i => i.state === 'pending').length;

            html += `
                <tr class="job-array-header" style="background: rgba(79, 195, 247, 0.08); border-left: 3px solid var(--accent-blue);">
                    <td colspan="7" style="padding: 0.8rem 1rem;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <strong style="color: var(--accent-blue);">🔗 Job Array:</strong>
                                <strong>${escapeHtml(jobArray.name)}</strong>
                                <span style="color: var(--text-muted); margin-left: 1rem;">
                                    ${jobArray.instances.length} of ${jobArray.size} instances
                                    ${runningCount > 0 ? `• ${runningCount} running` : ''}
                                    ${pendingCount > 0 ? `• ${pendingCount} pending` : ''}
                                    ${terminatedCount > 0 ? `• ${terminatedCount} terminated` : ''}
                                </span>
                            </div>
                        </div>
                    </td>
                </tr>
            `;

            jobArray.instances.forEach(instance => {
                html += renderInstanceRow(instance, globalIndex++, expandedInstanceIds, true);
            });

            html += `
                <tr class="job-array-spacer" style="height: 1rem; background: transparent;">
                    <td colspan="7" style="padding: 0; border: none;"></td>
                </tr>
            `;
        });

        standaloneInstances.forEach(instance => {
            html += renderInstanceRow(instance, globalIndex++, expandedInstanceIds, false);
        });

        tbody.style.opacity = '0';
        setTimeout(() => {
            tbody.innerHTML = html;
            tbody.style.opacity = '1';
        }, 150);
    } else {
        // Structure unchanged, update cells in place
        updateInstanceRows(instances, jobArrays);
    }
}

function updateInstanceRows(instances, jobArrays) {
    const tbody = document.getElementById('instances-tbody');
    if (!tbody) return;

    // Create map of instance data
    const instanceMap = new Map();
    instances.forEach(instance => {
        instanceMap.set(instance.instance_id, instance);
    });

    // Update each instance row
    tbody.querySelectorAll('tr.instance-row').forEach(row => {
        const instanceId = row.getAttribute('data-instance-id');
        const instance = instanceMap.get(instanceId);
        if (!instance) return;

        const launchTime = new Date(instance.launch_time);
        const stateClass = getStateClass(instance.state);

        // Calculate TTL remaining first
        let ttlRemaining = null;
        if (instance.ttl) {
            const ttlMinutes = parseTTL(instance.ttl);
            const elapsed = Math.floor((Date.now() - launchTime.getTime()) / 60000);
            const remaining = ttlMinutes - elapsed;
            if (remaining > 0) {
                ttlRemaining = formatDuration(remaining);
            } else {
                ttlRemaining = 'Expired';
            }
        }

        // Update state badge
        const stateTd = row.children[2];
        if (stateTd) {
            const newState = `<span class="badge badge-${stateClass}">${escapeHtml(instance.state)}</span>`;
            if (stateTd.innerHTML !== newState) {
                stateTd.style.transition = 'background-color 0.3s ease';
                stateTd.innerHTML = newState;
            }
        }

        // Update public IP
        const ipTd = row.children[4];
        if (ipTd) {
            const newIp = instance.public_ip ? `<code>${escapeHtml(instance.public_ip)}</code>` : '<span style="color: var(--text-muted);">—</span>';
            if (ipTd.innerHTML !== newIp) {
                ipTd.style.transition = 'opacity 0.3s ease';
                ipTd.style.opacity = '0.5';
                setTimeout(() => {
                    ipTd.innerHTML = newIp;
                    ipTd.style.opacity = '1';
                }, 150);
            }
        }

        // Update DNS name
        const dnsTd = row.children[5];
        if (dnsTd) {
            const newDns = instance.dns_name ? `<code>${escapeHtml(instance.dns_name)}</code>` : '<span style="color: var(--text-muted);">—</span>';
            if (dnsTd.innerHTML !== newDns) {
                dnsTd.style.transition = 'opacity 0.3s ease';
                dnsTd.style.opacity = '0.5';
                setTimeout(() => {
                    dnsTd.innerHTML = newDns;
                    dnsTd.style.opacity = '1';
                }, 150);
            }
        }

        // Update TTL display (ttlRemaining already calculated above)
        const ttlTd = row.children[6];
        if (ttlTd) {
            const ttlColor = ttlRemaining === 'Expired' ? 'var(--accent-red)' : ttlRemaining ? 'var(--accent-green)' : 'var(--text-muted)';

            let ttlDisplay;
            if (instance.state === 'terminated') {
                ttlDisplay = '<span style="color: var(--text-muted);">Terminated</span>';
            } else if (ttlRemaining) {
                ttlDisplay = `<span style="color: ${ttlColor};">${ttlRemaining}</span>`;
            } else {
                ttlDisplay = '<span style="color: var(--text-muted);">No TTL</span>';
            }

            if (ttlTd.innerHTML !== ttlDisplay) {
                ttlTd.style.transition = 'color 0.3s ease';
                ttlTd.innerHTML = ttlDisplay;
            }
        }
    });

    // Update job array headers
    Object.values(jobArrays).forEach(jobArray => {
        const runningCount = jobArray.instances.filter(i => i.state === 'running').length;
        const terminatedCount = jobArray.instances.filter(i => i.state === 'terminated').length;
        const pendingCount = jobArray.instances.filter(i => i.state === 'pending').length;

        // Find header row by checking for job array name
        const headers = tbody.querySelectorAll('tr.job-array-header');
        headers.forEach(header => {
            const headerText = header.textContent;
            if (headerText.includes(jobArray.name)) {
                const statusSpan = header.querySelector('span[style*="color: var(--text-muted)"]');
                if (statusSpan) {
                    const newStatus = `${jobArray.instances.length} of ${jobArray.size} instances
                                ${runningCount > 0 ? `• ${runningCount} running` : ''}
                                ${pendingCount > 0 ? `• ${pendingCount} pending` : ''}
                                ${terminatedCount > 0 ? `• ${terminatedCount} terminated` : ''}`;
                    if (statusSpan.textContent.trim() !== newStatus.trim()) {
                        statusSpan.style.transition = 'opacity 0.3s ease';
                        statusSpan.style.opacity = '0.5';
                        setTimeout(() => {
                            statusSpan.textContent = newStatus;
                            statusSpan.style.opacity = '1';
                        }, 150);
                    }
                }
            }
        });
    });
}

function renderInstanceRow(instance, index, expandedInstanceIds = new Set(), isJobArray = false) {
        const launchTime = new Date(instance.launch_time);
        const stateClass = getStateClass(instance.state);
        const rowId = `instance-${index}`;
        const detailId = `detail-${index}`;

        // Check if this instance should be expanded
        const isExpanded = expandedInstanceIds.has(instance.instance_id);
        const displayStyle = isExpanded ? 'table-row' : 'none';
        const arrowIcon = isExpanded ? '▲' : '▼';

        // Add indentation for job array instances
        const nameCellStyle = isJobArray ? 'padding-left: 2.5rem;' : '';

        // For terminated instances, show runtime. For others, show age.
        let ageDisplay;
        if (instance.state === 'terminated' && instance.termination_time) {
            const runtime = Math.floor((instance.termination_time - launchTime) / 1000 / 60); // minutes
            ageDisplay = `Ran ${formatDuration(runtime)}`;
        } else {
            ageDisplay = formatAge(launchTime);
        }

        // Calculate TTL remaining if present
        let ttlRemaining = null;
        let ttlColor = 'var(--text-muted)';
        if (instance.ttl) {
            const ttlMinutes = parseTTL(instance.ttl);
            const elapsed = Math.floor((Date.now() - launchTime.getTime()) / 60000);
            const remaining = ttlMinutes - elapsed;
            if (remaining > 0) {
                ttlRemaining = formatDuration(remaining);
                ttlColor = 'var(--accent-green)';
            } else {
                ttlRemaining = 'Expired';
                ttlColor = 'var(--accent-red)';
            }
        }

        // TTL display for table column
        let ttlDisplay;
        if (instance.state === 'terminated') {
            ttlDisplay = '<span style="color: var(--text-muted);">Terminated</span>';
        } else if (ttlRemaining) {
            ttlDisplay = `<span style="color: ${ttlColor};">${ttlRemaining}</span>`;
        } else {
            ttlDisplay = '<span style="color: var(--text-muted);">No TTL</span>';
        }

        return `
            <tr id="${rowId}" class="instance-row" data-instance-id="${escapeHtml(instance.instance_id)}" onclick="toggleInstanceDetails('${detailId}', '${rowId}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleInstanceDetails('${detailId}','${rowId}')}" tabindex="0" aria-expanded="false" style="cursor: pointer;">
                <td data-label="Name" style="${nameCellStyle}"><strong>${escapeHtml(instance.name)}</strong> <span style="color: var(--text-muted); font-size: 0.85rem;">${arrowIcon}</span></td>
                <td data-label="Type"><code>${escapeHtml(instance.instance_type)}</code></td>
                <td data-label="State"><span class="badge badge-${stateClass}">${escapeHtml(instance.state)}</span></td>
                <td data-label="Region"><code>${escapeHtml(instance.region)}</code></td>
                <td data-label="Public IP">${instance.public_ip ? `<code>${escapeHtml(instance.public_ip)}</code>` : '<span style="color: var(--text-muted);">—</span>'}</td>
                <td data-label="DNS Name">${instance.dns_name ? `<code>${escapeHtml(instance.dns_name)}</code>` : '<span style="color: var(--text-muted);">—</span>'}</td>
                <td data-label="TTL">${ttlDisplay}</td>
            </tr>
            <tr id="${detailId}" class="instance-detail" style="display: ${displayStyle};">
                <td colspan="7" style="padding: 0; background: rgba(79, 195, 247, 0.03);">
                    <div style="padding: 1.5rem; border-top: 1px solid var(--border);">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem;">
                            <div>
                                <h4 style="margin: 0 0 0.5rem 0; color: var(--accent-blue); font-size: 0.9rem;">Instance Details</h4>
                                <div style="font-size: 0.9rem; line-height: 1.8;">
                                    <div><strong>Instance ID:</strong> <code>${escapeHtml(instance.instance_id)}</code></div>
                                    <div><strong>AZ:</strong> <code>${escapeHtml(instance.availability_zone)}</code></div>
                                    <div><strong>Private IP:</strong> ${instance.private_ip ? `<code>${escapeHtml(instance.private_ip)}</code>` : '<span style="color: var(--text-muted);">—</span>'}</div>
                                    <div><strong>Spot:</strong> ${instance.spot_instance ? '<span style="color: var(--accent-green);">Yes</span>' : '<span style="color: var(--text-muted);">No</span>'}</div>
                                    ${instance.key_name ? `<div><strong>Key Pair:</strong> <code>${escapeHtml(instance.key_name)}</code></div>` : ''}
                                </div>
                            </div>
                            <div>
                                <h4 style="margin: 0 0 0.5rem 0; color: var(--accent-blue); font-size: 0.9rem;">Lifecycle</h4>
                                <div style="font-size: 0.9rem; line-height: 1.8;">
                                    <div><strong>Launched:</strong> <span style="color: var(--text-secondary);">${launchTime.toLocaleString()}</span></div>
                                    ${instance.termination_time ? `<div><strong>Terminated:</strong> <span style="color: var(--text-secondary);">${instance.termination_time.toLocaleString()}</span></div>` : ''}
                                    ${instance.termination_time ? `<div><strong>Runtime:</strong> <span style="color: var(--text-secondary);">${ageDisplay}</span></div>` : ''}
                                    ${instance.ttl ? `<div><strong>TTL:</strong> <code>${escapeHtml(instance.ttl)}</code></div>` : ''}
                                    ${ttlRemaining && !instance.termination_time ? `<div><strong>TTL Remaining:</strong> <span style="color: ${ttlRemaining === 'Expired' ? 'var(--accent-red)' : 'var(--accent-green)'};">${ttlRemaining}</span></div>` : ''}
                                    ${instance.tags['spawn:idle-timeout'] ? `<div><strong>Idle Timeout:</strong> <code>${escapeHtml(instance.tags['spawn:idle-timeout'])}</code></div>` : ''}
                                    ${instance.tags['spawn:session-timeout'] ? `<div><strong>Session Timeout:</strong> <code>${escapeHtml(instance.tags['spawn:session-timeout'])}</code></div>` : ''}
                                </div>
                            </div>
                        </div>
                        <div style="margin-top: 1.5rem;">
                            <h4 style="margin: 0 0 0.5rem 0; color: var(--accent-blue); font-size: 0.9rem;">Tags</h4>
                            <div style="font-size: 0.85rem; line-height: 1.6;">
                                ${Object.entries(instance.tags)
                                    .filter(([key]) => !key.startsWith('aws:') && key !== 'Name')
                                    .map(([key, value]) => `<div><code style="color: var(--accent-blue);">${escapeHtml(key)}</code>: <span style="color: var(--text-secondary);">${escapeHtml(value)}</span></div>`)
                                    .join('') || '<span style="color: var(--text-muted);">No custom tags</span>'}
                            </div>
                        </div>
                    </div>
                </td>
            </tr>
        `;
}

function toggleInstanceDetails(detailId, rowId) {
    const detailRow = document.getElementById(detailId);
    const instanceRow = document.getElementById(rowId);

    if (!detailRow || !instanceRow) return;

    const isVisible = detailRow.style.display !== 'none';

    // Toggle display
    detailRow.style.display = isVisible ? 'none' : 'table-row';
    instanceRow.setAttribute('aria-expanded', !isVisible);

    // Update arrow indicator
    const arrow = instanceRow.querySelector('span');
    if (arrow) {
        arrow.textContent = isVisible ? '▼' : '▲';
    }
}

function parseTTL(ttlStr) {
    // Parse TTL string like "1h", "30m", "2h30m" to minutes
    const hours = ttlStr.match(/(\d+)h/);
    const minutes = ttlStr.match(/(\d+)m/);

    let total = 0;
    if (hours) total += parseInt(hours[1]) * 60;
    if (minutes) total += parseInt(minutes[1]);

    return total;
}

function formatDuration(minutes) {
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatAge(date) {
    const now = new Date();
    const diff = now - date;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

function getStateClass(state) {
    const stateMap = {
        'running': 'success',
        'stopped': 'warning',
        'terminated': 'danger',
        'pending': 'info',
        'stopping': 'warning',
        'shutting-down': 'danger'
    };
    return stateMap[state] || 'default';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Table filtering, searching, and sorting
let allInstancesCache = [];
let currentSort = { column: null, direction: 'asc' };

function applyTableFilters() {
    if (allInstancesCache.length === 0) return;

    const searchTerm = document.getElementById('search-input')?.value.toLowerCase() || '';
    const stateFilter = document.getElementById('state-filter')?.value || '';
    const regionFilter = document.getElementById('region-filter')?.value || '';

    let filteredInstances = allInstancesCache.filter(instance => {
        // Search filter
        const searchMatch = !searchTerm ||
            instance.name.toLowerCase().includes(searchTerm) ||
            instance.instance_id.toLowerCase().includes(searchTerm) ||
            instance.instance_type.toLowerCase().includes(searchTerm) ||
            Object.values(instance.tags).some(v => String(v).toLowerCase().includes(searchTerm));

        // State filter
        const stateMatch = !stateFilter || instance.state === stateFilter;

        // Region filter
        const regionMatch = !regionFilter || instance.region === regionFilter;

        return searchMatch && stateMatch && regionMatch;
    });

    // Apply current sort
    if (currentSort.column) {
        filteredInstances = sortInstances(filteredInstances, currentSort.column, currentSort.direction);
    }

    // Preserve expansion state
    const tbody = document.getElementById('instances-tbody');
    const expandedInstanceIds = new Set();
    if (tbody) {
        tbody.querySelectorAll('.instance-detail').forEach(detailRow => {
            if (detailRow.style.display === 'table-row') {
                const instanceRow = detailRow.previousElementSibling;
                if (instanceRow) {
                    const instanceId = instanceRow.getAttribute('data-instance-id');
                    if (instanceId) {
                        expandedInstanceIds.add(instanceId);
                    }
                }
            }
        });
    }

    displayInstances(filteredInstances, expandedInstanceIds);
    announce(filteredInstances.length + ' instances shown');
}

function clearTableFilters() {
    const searchInput = document.getElementById('search-input');
    const stateFilter = document.getElementById('state-filter');
    const regionFilter = document.getElementById('region-filter');

    if (searchInput) searchInput.value = '';
    if (stateFilter) stateFilter.value = '';
    if (regionFilter) regionFilter.value = '';

    applyTableFilters();
}

function sortTable(column) {
    // Toggle direction if same column, otherwise default to ascending
    if (currentSort.column === column) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.column = column;
        currentSort.direction = 'asc';
    }

    // Update sort indicators and aria-sort
    document.querySelectorAll('.instances-table th[aria-sort]').forEach(th => {
        th.setAttribute('aria-sort', 'none');
    });
    ['name', 'type', 'state', 'region', 'ip', 'dns', 'ttl'].forEach(col => {
        const indicator = document.getElementById(`sort-${col}`);
        if (indicator) {
            if (col === column) {
                indicator.textContent = currentSort.direction === 'asc' ? '▲' : '▼';
                indicator.style.color = 'var(--accent-blue)';
            } else {
                indicator.textContent = '';
            }
        }
    });
    const activeHeader = document.querySelector(`.instances-table th[onclick*="sortTable('${column}')"]`);
    if (activeHeader) {
        activeHeader.setAttribute('aria-sort', currentSort.direction === 'asc' ? 'ascending' : 'descending');
    }

    applyTableFilters();
    announce('Table sorted by ' + column + ', ' + (currentSort.direction === 'asc' ? 'ascending' : 'descending'));
}

function sortInstances(instances, column, direction) {
    return [...instances].sort((a, b) => {
        let aVal, bVal;

        switch (column) {
            case 'name':
                aVal = a.name.toLowerCase();
                bVal = b.name.toLowerCase();
                break;
            case 'type':
                aVal = a.instance_type;
                bVal = b.instance_type;
                break;
            case 'state':
                aVal = a.state;
                bVal = b.state;
                break;
            case 'region':
                aVal = a.region;
                bVal = b.region;
                break;
            case 'ip':
                aVal = a.public_ip || '';
                bVal = b.public_ip || '';
                break;
            case 'dns':
                aVal = a.dns_name || '';
                bVal = b.dns_name || '';
                break;
            case 'ttl':
                aVal = a.ttl ? parseTTL(a.ttl) : 0;
                bVal = b.ttl ? parseTTL(b.ttl) : 0;
                break;
            default:
                return 0;
        }

        if (aVal < bVal) return direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return direction === 'asc' ? 1 : -1;
        return 0;
    });
}

function populateRegionFilter(instances) {
    const regionFilter = document.getElementById('region-filter');
    if (!regionFilter) return;

    // Get unique regions
    const regions = [...new Set(instances.map(i => i.region))].sort();

    // Preserve current selection
    const currentValue = regionFilter.value;

    // Clear and repopulate
    regionFilter.innerHTML = '<option value="">All Regions</option>';
    regions.forEach(region => {
        const option = document.createElement('option');
        option.value = region;
        option.textContent = region;
        regionFilter.appendChild(option);
    });

    // Restore selection
    regionFilter.value = currentValue;
}

// ==================== SWEEP MANAGEMENT ====================

// Current dashboard state
let currentDashboardTab = 'instances';
let allSweepsCache = [];
let sweepSortState = { column: null, direction: 'asc' };

// Tab switching
function switchDashboardTab(tab) {
    currentDashboardTab = tab;

    const allTabs = ['instances', 'sweeps', 'autoscale', 'settings', 'software', 'watches'];
    allTabs.forEach(t => {
        const btn = document.getElementById(`tab-${t}`);
        const content = document.getElementById(`${t}-tab-content`);
        if (btn) {
            btn.classList.remove('active');
            btn.style.borderBottom = '3px solid transparent';
            btn.style.color = 'var(--text-muted)';
            btn.setAttribute('aria-selected', 'false');
        }
        if (content) content.style.display = 'none';
    });

    const activeBtn = document.getElementById(`tab-${tab}`);
    const activeContent = document.getElementById(`${tab}-tab-content`);
    if (activeBtn) {
        activeBtn.classList.add('active');
        activeBtn.style.borderBottom = '3px solid var(--accent-blue)';
        activeBtn.style.color = 'var(--accent-blue)';
        activeBtn.setAttribute('aria-selected', 'true');
    }
    if (activeContent) activeContent.style.display = 'block';
    announce(tab + ' tab selected');

    if (tab === 'instances') {
        loadDashboard();
    } else if (tab === 'sweeps') {
        loadSweeps();
    } else if (tab === 'autoscale') {
        loadAutoscaleGroups();
        loadCostSummary();
        loadCostChart(30);
    } else if (tab === 'settings') {
        loadAlertPreferences();
    } else if (tab === 'software') {
        loadStrataCatalog();
    } else if (tab === 'watches') {
        loadWatches();
    }
}

// Refresh current view
async function refreshCurrentDashboardView() {
    if (currentDashboardTab === 'instances') {
        await loadDashboard();
    } else if (currentDashboardTab === 'sweeps') {
        // Skip polling if WebSocket is connected
        if (!dashboardWebSocket || !dashboardWebSocket.isConnected) {
            await loadSweeps();
        }
    } else if (currentDashboardTab === 'autoscale') {
        // Skip polling if WebSocket is connected
        if (!dashboardWebSocket || !dashboardWebSocket.isConnected) {
            await loadAutoscaleGroups();
        }
        // Always refresh cost summary (not real-time)
        await loadCostSummary();
    } else if (currentDashboardTab === 'watches') {
        await loadWatches();
    }
}

// Load sweeps from API
async function loadSweeps() {
    const tbody = document.getElementById('sweeps-tbody');
    const errorDiv = document.getElementById('sweeps-error');
    const loadingDiv = document.getElementById('sweeps-loading');

    try {
        if (loadingDiv) loadingDiv.style.display = 'block';
        if (errorDiv) errorDiv.style.display = 'none';
        if (tbody) tbody.innerHTML = '';

        // Call Lambda API endpoint
        const apiEndpoint = 'https://api.spore.host/api/sweeps';

        const response = await fetch(apiEndpoint, {
            method: 'GET',
            headers: getAPIHeaders(),
            credentials: 'include'
        });
        if (!response.ok) {
            throw new Error(`API returned ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        if (loadingDiv) loadingDiv.style.display = 'none';
        if (data.success && data.sweeps && data.sweeps.length > 0) {
            allSweepsCache = data.sweeps;
            applySweepFilters();
            updateLastRefreshedTime();
        } else {
            allSweepsCache = [];
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="7" style="text-align: center; padding: 3rem;">
                            <div style="max-width: 600px; margin: 0 auto;">
                                <div style="font-size: 3rem; margin-bottom: 1rem;">📊</div>
                                <h3 style="color: var(--accent-blue); margin-bottom: 1rem;">No Sweeps Yet</h3>
                                <p style="color: var(--text-secondary); margin-bottom: 2rem; line-height: 1.8;">
                                    Parameter sweeps let you launch multiple instances with different configurations. They'll appear here automatically.
                                </p>
                                <div style="background: rgba(79, 195, 247, 0.08); border: 1px solid rgba(79, 195, 247, 0.3); border-radius: 8px; padding: 1.5rem; text-align: left;">
                                    <h4 style="color: var(--accent-blue); margin-bottom: 1rem; text-align: center;">🚀 Launch Your First Sweep</h4>
                                    <pre style="background: var(--bg-dark); padding: 1rem; border-radius: 4px; overflow-x: auto;">spawn sweep --file params.json --detach</pre>
                                    <p style="text-align: center; margin-top: 1rem; color: var(--text-muted); font-size: 0.9rem;">
                                        The <code>--detach</code> flag runs the sweep in Lambda so you can close your terminal.
                                    </p>
                                </div>
                            </div>
                        </td>
                    </tr>
                `;
            }
        }
    } catch (error) {
        console.error('Failed to load sweeps:', error);
        if (loadingDiv) loadingDiv.style.display = 'none';
        if (errorDiv) {
            errorDiv.style.display = 'block';
            const errorMessage = error.message || 'Unknown error';
            errorDiv.innerHTML = `<strong>Error:</strong> ${errorMessage}`;
        }
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 2rem; color: var(--accent-red);">
                        Failed to load sweeps. Please try again.
                    </td>
                </tr>
            `;
        }
    }
}
// Render sweeps table
function renderSweepsTable(sweeps) {
    const tbody = document.getElementById('sweeps-tbody');
    if (!tbody) return;
    if (sweeps.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; padding: 2rem; color: var(--text-muted);">
                    No sweeps match your filters.
                </td>
            </tr>
        `;
        return;
    }
    tbody.innerHTML = sweeps.map(sweep => {
        const statusIcon = getSweepStatusIcon(sweep.status);
        const progress = `${sweep.launched}/${sweep.total_params}`;
        const progressPercent = sweep.total_params > 0 ? (sweep.launched / sweep.total_params * 100) : 0;
        const failedText = sweep.failed > 0 ? ` (${sweep.failed} failed)` : '';
        const createdTime = formatRelativeTime(new Date(sweep.created_at));
        const costText = sweep.estimated_cost > 0 ? `$${sweep.estimated_cost.toFixed(2)}` : 'N/A';
        // Region display: show count for multi-region, single region otherwise
        const regionInfo = sweep.multi_region && sweep.region_status
            ? `${Object.keys(sweep.region_status).length} regions`
            : sweep.region;
        // Action buttons
        let actionButtons = '';
        if (sweep.status === 'RUNNING') {
            actionButtons = `
                <button onclick="cancelSweep('${sweep.sweep_id}')"
                        style="padding: 0.4rem 0.8rem; background: var(--accent-red); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85rem; transition: opacity 0.2s;"
                        onmouseover="this.style.opacity='0.8'"
                        onmouseout="this.style.opacity='1'">
                    ❌ Cancel
                </button>
            `;
        } else {
            actionButtons = `<span style="color: var(--text-muted); font-size: 0.85rem;">—</span>`;
        }
        return `
            <tr data-sweep-id="${sweep.sweep_id}">
                <td>
                    <div style="font-weight: 500;">${sweep.sweep_name || sweep.sweep_id}</div>
                    <div style="font-size: 0.85rem; color: var(--text-muted); font-family: monospace; margin-top: 0.2rem;">${sweep.sweep_id}</div>
                </td>
                <td>
                    <span style="display: inline-flex; align-items: center; gap: 0.4rem;">
                        <span style="font-size: 1.2rem;">${statusIcon}</span>
                        <span>${sweep.status}</span>
                    </span>
                </td>
                <td>
                    <div style="margin-bottom: 0.3rem;">${progress}${failedText}</div>
                    <div style="width: 100%; background: var(--bg-dark); border-radius: 4px; height: 6px; overflow: hidden;">
                        <div style="width: ${progressPercent}%; background: var(--accent-blue); height: 100%; transition: width 0.3s;"></div>
                    </div>
                </td>
                <td>${regionInfo}</td>
                <td title="${new Date(sweep.created_at).toLocaleString()}">${createdTime}</td>
                <td>${costText}</td>
                <td>${actionButtons}</td>
            </tr>
        `;
    }).join('');
}
// Get status icon
function getSweepStatusIcon(status) {
    switch (status.toUpperCase()) {
        case 'RUNNING':
        case 'INITIALIZING':
            return '🚀';
        case 'COMPLETED':
            return '✅';
        case 'FAILED':
            return '❌';
        case 'CANCELLED':
            return '⚠️';
        default:
            return '❓';
    }
}
// Format relative time
function formatRelativeTime(date) {
    const now = new Date();
    const diff = now - date;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (seconds < 60) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
}
// Apply sweep filters
function applySweepFilters() {
    const searchInput = document.getElementById('sweep-search-input');
    const statusFilter = document.getElementById('sweep-status-filter');
    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
    const statusValue = statusFilter ? statusFilter.value : '';
    let filtered = allSweepsCache.filter(sweep => {
        // Search filter
        if (searchTerm) {
            const name = (sweep.sweep_name || '').toLowerCase();
            const id = sweep.sweep_id.toLowerCase();
            if (!name.includes(searchTerm) && !id.includes(searchTerm)) {
                return false;
            }
        }
        // Status filter
        if (statusValue && sweep.status !== statusValue) {
            return false;
        }
        return true;
    });
    // Apply sorting
    if (sweepSortState.column) {
        filtered = sortSweeps(filtered, sweepSortState.column, sweepSortState.direction);
    }
    renderSweepsTable(filtered);
    announce(filtered.length + ' sweeps shown');
}
// Sort sweeps
function sortSweeps(sweeps, column, direction) {
    return sweeps.sort((a, b) => {
        let aVal, bVal;
        switch (column) {
            case 'name':
                aVal = (a.sweep_name || a.sweep_id).toLowerCase();
                bVal = (b.sweep_name || b.sweep_id).toLowerCase();
                break;
            case 'status':
                aVal = a.status;
                bVal = b.status;
                break;
            case 'progress':
                aVal = a.total_params > 0 ? (a.launched / a.total_params) : 0;
                bVal = b.total_params > 0 ? (b.launched / b.total_params) : 0;
                break;
            case 'region':
                aVal = a.region;
                bVal = b.region;
                break;
            case 'created':
                aVal = new Date(a.created_at).getTime();
                bVal = new Date(b.created_at).getTime();
                break;
            case 'cost':
                aVal = a.estimated_cost || 0;
                bVal = b.estimated_cost || 0;
                break;
            default:
                return 0;
        }
        if (aVal < bVal) return direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return direction === 'asc' ? 1 : -1;
        return 0;
    });
}
// Clear sweep filters
function clearSweepFilters() {
    const searchInput = document.getElementById('sweep-search-input');
    const statusFilter = document.getElementById('sweep-status-filter');
    if (searchInput) searchInput.value = '';
    if (statusFilter) statusFilter.value = '';
    applySweepFilters();
}
// Sort sweeps table
function sortSweepsTable(column) {
    // Update sort state
    if (sweepSortState.column === column) {
        sweepSortState.direction = sweepSortState.direction === 'asc' ? 'desc' : 'asc';
    } else {
        sweepSortState.column = column;
        sweepSortState.direction = 'asc';
    }
    // Update sort indicators and aria-sort
    document.querySelectorAll('.sweeps-table th[aria-sort]').forEach(th => {
        th.setAttribute('aria-sort', 'none');
    });
    ['name', 'status', 'progress', 'region', 'created', 'cost'].forEach(col => {
        const indicator = document.getElementById(`sweep-sort-${col}`);
        if (indicator) {
            if (col === column) {
                indicator.textContent = sweepSortState.direction === 'asc' ? '▲' : '▼';
            } else {
                indicator.textContent = '';
            }
        }
    });
    const activeHeader = document.querySelector(`.sweeps-table th[onclick*="sortSweepsTable('${column}')"]`);
    if (activeHeader) {
        activeHeader.setAttribute('aria-sort', sweepSortState.direction === 'asc' ? 'ascending' : 'descending');
    }
    // Sort filtered results
    applySweepFilters();
    announce('Sweeps sorted by ' + column + ', ' + (sweepSortState.direction === 'asc' ? 'ascending' : 'descending'));
}
// Cancel sweep
async function cancelSweep(sweepId) {
    if (!confirm('Are you sure you want to cancel this sweep? Running instances will be terminated.')) {
        return;
    }
    try {
        const apiEndpoint = `https://api.spore.host/api/sweeps/${sweepId}/cancel`;
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: getAPIHeaders(),
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`API returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.success) {
            alert(`Sweep cancelled successfully. Terminated ${data.instances_terminated} instance(s).`);
            await loadSweeps();
        } else {
            throw new Error(data.error || 'Failed to cancel sweep');
        }
    } catch (error) {
        console.error('Failed to cancel sweep:', error);
        alert(`Failed to cancel sweep: ${error.message}`);
    }
}

async function deleteCompletedSweeps() {
    console.log('deleteCompletedSweeps called');
    console.log('allSweepsCache:', allSweepsCache);

    // Count completed/cancelled sweeps
    const sweepsToDelete = allSweepsCache.filter(s =>
        s.status === 'COMPLETED' || s.status === 'CANCELLED' || s.status === 'FAILED'
    );

    console.log('Sweeps to delete:', sweepsToDelete.length, sweepsToDelete);

    if (sweepsToDelete.length === 0) {
        alert('No completed, cancelled, or failed sweeps to delete.');
        return;
    }

    if (!confirm(`Delete ${sweepsToDelete.length} completed/cancelled/failed sweep(s)? This cannot be undone.`)) {
        console.log('User cancelled deletion');
        return;
    }

    try {
        console.log('Calling cleanup API...');
        const apiEndpoint = 'https://api.spore.host/api/sweeps/cleanup';
        const payload = {
            sweep_ids: sweepsToDelete.map(s => s.sweep_id)
        };
        console.log('Payload:', payload);

        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: getAPIHeaders(),
            credentials: 'include',
            body: JSON.stringify(payload)
        });

        console.log('Response status:', response.status);

        if (!response.ok) {
            throw new Error(`API returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('Response data:', data);

        if (data.success) {
            alert(`Successfully deleted ${data.deleted_count} sweep(s).`);
            await loadSweeps();
        } else {
            throw new Error(data.error || 'Failed to delete sweeps');
        }
    } catch (error) {
        console.error('Failed to delete sweeps:', error);
        alert(`Failed to delete sweeps: ${error.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════
// Autoscale Groups Functions
// ═══════════════════════════════════════════════════════════════

let allAutoscaleGroupsCache = [];

// Load autoscale groups from API
async function loadAutoscaleGroups() {
    const tbody = document.getElementById('autoscale-tbody');
    const errorDiv = document.getElementById('autoscale-error');
    const loadingDiv = document.getElementById('autoscale-loading');

    try {
        if (loadingDiv) loadingDiv.style.display = 'block';
        if (errorDiv) errorDiv.style.display = 'none';
        if (tbody) tbody.innerHTML = '';

        const apiEndpoint = 'https://api.spore.host/api/autoscale-groups';

        const response = await fetch(apiEndpoint, {
            method: 'GET',
            headers: getAPIHeaders(),
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`API returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (loadingDiv) loadingDiv.style.display = 'none';

        if (data.success && data.autoscale_groups && data.autoscale_groups.length > 0) {
            allAutoscaleGroupsCache = data.autoscale_groups;
            applyAutoscaleFilters();
        } else {
            allAutoscaleGroupsCache = [];
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6" style="text-align: center; padding: 3rem;">
                            <div style="max-width: 600px; margin: 0 auto;">
                                <div style="font-size: 3rem; margin-bottom: 1rem;">⚙️</div>
                                <h3 style="color: var(--accent-blue); margin-bottom: 1rem;">No Autoscale Groups Yet</h3>
                                <p style="color: var(--text-secondary); margin-bottom: 2rem; line-height: 1.8;">
                                    Create autoscale groups to automatically manage capacity based on queues, metrics, or schedules.
                                </p>
                                <div style="background: rgba(79, 195, 247, 0.08); border: 1px solid rgba(79, 195, 247, 0.3); border-radius: 8px; padding: 1.5rem; text-align: left;">
                                    <h4 style="color: var(--accent-blue); margin-bottom: 1rem; text-align: center;">🚀 Quick Start</h4>
                                    <pre style="background: var(--bg-dark); padding: 1rem; border-radius: 4px; overflow-x: auto;"><code>spawn autoscale launch \\
  --name my-workers \\
  --desired 5 --min 2 --max 10 \\
  --instance-type t3.micro</code></pre>
                                </div>
                            </div>
                        </td>
                    </tr>
                `;
            }
        }
    } catch (error) {
        console.error('Failed to load autoscale groups:', error);

        if (loadingDiv) loadingDiv.style.display = 'none';

        if (errorDiv) {
            errorDiv.style.display = 'block';
            errorDiv.innerHTML = `<strong>Error:</strong> ${error.message || 'Unknown error'}`;
        }
    }
}

// Load cost summary
async function loadCostSummary() {
    try {
        const apiEndpoint = 'https://api.spore.host/api/cost-summary';

        const response = await fetch(apiEndpoint, {
            method: 'GET',
            headers: getAPIHeaders(),
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
        }

        const data = await response.json();

        if (data.success && data.cost) {
            const cost = data.cost;

            // Update cost widgets
            const hourlyElem = document.getElementById('cost-hourly');
            const monthlyElem = document.getElementById('cost-monthly');
            const countElem = document.getElementById('cost-instance-count');
            const breakdownElem = document.getElementById('cost-breakdown');

            if (hourlyElem) hourlyElem.textContent = `$${cost.total_hourly_cost.toFixed(2)}`;
            if (monthlyElem) monthlyElem.textContent = `$${cost.estimated_monthly_cost.toFixed(2)}`;
            if (countElem) countElem.textContent = cost.instance_count;

            // Format breakdown
            if (breakdownElem && cost.breakdown_by_type) {
                const breakdownHTML = Object.entries(cost.breakdown_by_type)
                    .sort((a, b) => b[1].count - a[1].count)
                    .map(([type, info]) =>
                        `${type}: ${info.count}x ($${info.hourly_cost.toFixed(2)}/hr)`
                    )
                    .join(' • ');

                breakdownElem.innerHTML = breakdownHTML || 'No running instances';
            }
        }
    } catch (error) {
        console.error('Failed to load cost summary:', error);
    }
}

// Render autoscale groups table
function renderAutoscaleGroupsTable(groups) {
    const tbody = document.getElementById('autoscale-tbody');
    if (!tbody) return;

    tbody.innerHTML = '';

    groups.forEach(group => {
        const row = document.createElement('tr');
        row.className = 'autoscale-group-row';
        row.style.cursor = 'pointer';
        row.onclick = () => toggleGroupDetails(group.autoscale_group_id);

        // Name
        const nameCell = document.createElement('td');
        nameCell.innerHTML = `
            <div style="font-weight: 500;">${group.group_name || group.autoscale_group_id}</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">${group.autoscale_group_id.substring(0, 12)}...</div>
        `;
        row.appendChild(nameCell);

        // Status
        const statusCell = document.createElement('td');
        statusCell.innerHTML = getGroupStatusBadge(group.status);
        row.appendChild(statusCell);

        // Capacity
        const capacityCell = document.createElement('td');
        capacityCell.innerHTML = `
            <div>${group.current_capacity} / ${group.desired_capacity}</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">
                ${group.current_capacity === group.desired_capacity ? '✅ At target' : '⏳ Scaling'}
            </div>
        `;
        row.appendChild(capacityCell);

        // Min/Max
        const rangeCell = document.createElement('td');
        rangeCell.textContent = `${group.min_capacity} / ${group.max_capacity}`;
        row.appendChild(rangeCell);

        // Policy
        const policyCell = document.createElement('td');
        policyCell.innerHTML = formatPolicyType(group.policy_type);
        row.appendChild(policyCell);

        // Last Event
        const eventCell = document.createElement('td');
        eventCell.textContent = formatRelativeTime(new Date(group.last_scale_event));
        eventCell.style.color = 'var(--text-muted)';
        row.appendChild(eventCell);

        // Actions
        const actionsCell = document.createElement('td');
        actionsCell.innerHTML = renderGroupActions(group);
        actionsCell.onclick = e => e.stopPropagation(); // Don't toggle details on action click
        row.appendChild(actionsCell);

        tbody.appendChild(row);

        // Add details row (hidden by default)
        const detailRow = document.createElement('tr');
        detailRow.id = `detail-${group.autoscale_group_id}`;
        detailRow.className = 'autoscale-group-detail';
        detailRow.style.display = 'none';

        const detailCell = document.createElement('td');
        detailCell.colSpan = 7;
        detailCell.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-muted);">Loading details...</div>';
        detailRow.appendChild(detailCell);

        tbody.appendChild(detailRow);
    });
}

// Toggle group details
async function toggleGroupDetails(groupId) {
    const detailRow = document.getElementById(`detail-${groupId}`);
    if (!detailRow) return;

    if (detailRow.style.display === 'table-row') {
        detailRow.style.display = 'none';
        return;
    }

    // Show loading
    detailRow.style.display = 'table-row';
    detailRow.querySelector('td').innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-muted);">Loading details...</div>';

    try {
        const apiEndpoint = `https://api.spore.host/api/autoscale-groups/${groupId}`;

        const response = await fetch(apiEndpoint, {
            method: 'GET',
            headers: getAPIHeaders(),
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
        }

        const data = await response.json();

        if (data.success && data.group) {
            renderGroupDetails(detailRow, data.group);
        } else {
            throw new Error('Failed to load group details');
        }
    } catch (error) {
        console.error('Failed to load group details:', error);
        detailRow.querySelector('td').innerHTML = `<div style="padding: 1rem; text-align: center; color: var(--accent-red);">Error: ${error.message}</div>`;
    }
}

// Render group details
function renderGroupDetails(detailRow, group) {
    const cell = detailRow.querySelector('td');

    let detailHTML = `
        <div style="padding: 1.5rem; background: rgba(0, 0, 0, 0.2); border-radius: 8px;">
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
                <div>
                    <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.5rem;">Healthy Instances</div>
                    <div style="font-size: 1.5rem; font-weight: bold; color: var(--accent-green);">${group.healthy_count}</div>
                </div>
                <div>
                    <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.5rem;">Unhealthy Instances</div>
                    <div style="font-size: 1.5rem; font-weight: bold; color: var(--accent-red);">${group.unhealthy_count}</div>
                </div>
                <div>
                    <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.5rem;">Pending Instances</div>
                    <div style="font-size: 1.5rem; font-weight: bold; color: var(--accent-blue);">${group.pending_count}</div>
                </div>
            </div>
    `;

    // Queue depth gauge (Phase 5)
    if (group.queue_depth !== null && group.queue_depth !== undefined && group.policy_type === 'queue') {
        detailHTML += `<div style="margin-bottom: 1.5rem;">
            <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.75rem;">Queue Depth</div>
            <div id="queue-gauge-${group.autoscale_group_id}" style="display: inline-block;"></div>
        </div>`;
    }

    if (group.instances && group.instances.length > 0) {
        detailHTML += `
            <h4 style="margin-bottom: 1rem; color: var(--text-primary);">Instances</h4>
            <div style="overflow-x: auto;">
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="background: rgba(0, 0, 0, 0.3);">
                            <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border);">Instance ID</th>
                            <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border);">State</th>
                            <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border);">Health</th>
                            <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border);">Launched</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        group.instances.forEach(inst => {
            const healthBadge = inst.health_status === 'healthy'
                ? '<span style="color: var(--accent-green);">✅ Healthy</span>'
                : inst.health_status === 'pending'
                ? '<span style="color: var(--accent-blue);">⏳ Pending</span>'
                : '<span style="color: var(--accent-red);">❌ Unhealthy</span>';

            detailHTML += `
                <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
                    <td style="padding: 0.5rem; font-family: monospace; font-size: 0.9rem;">${inst.instance_id}</td>
                    <td style="padding: 0.5rem;">${inst.state}</td>
                    <td style="padding: 0.5rem;">${healthBadge}</td>
                    <td style="padding: 0.5rem; color: var(--text-muted); font-size: 0.9rem;">${formatRelativeTime(new Date(inst.launched_at))}</td>
                </tr>
            `;
        });

        detailHTML += `
                    </tbody>
                </table>
            </div>
        `;
    } else {
        detailHTML += '<p style="color: var(--text-muted); text-align: center;">No instances</p>';
    }

    detailHTML += '</div>';

    cell.innerHTML = detailHTML;

    // Render queue depth gauge if applicable
    if (group.queue_depth !== null && group.queue_depth !== undefined && group.policy_type === 'queue') {
        const gaugeContainer = document.getElementById(`queue-gauge-${group.autoscale_group_id}`);
        if (gaugeContainer) {
            const threshold = group.max_capacity || 100;
            renderQueueDepthGauge(gaugeContainer, group.queue_depth, threshold);
        }
    }
}

// Get group status badge
function getGroupStatusBadge(status) {
    switch (status) {
        case 'active':
            return '<span style="background: rgba(102, 187, 106, 0.2); color: var(--accent-green); padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.85rem; font-weight: 500;">✅ Active</span>';
        case 'paused':
            return '<span style="background: rgba(255, 193, 7, 0.2); color: #FFC107; padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.85rem; font-weight: 500;">⏸️ Paused</span>';
        case 'terminated':
            return '<span style="background: rgba(244, 67, 54, 0.2); color: var(--accent-red); padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.85rem; font-weight: 500;">❌ Terminated</span>';
        default:
            return '<span style="background: rgba(158, 158, 158, 0.2); color: var(--text-muted); padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.85rem; font-weight: 500;">❓ Unknown</span>';
    }
}

// Format policy type
function formatPolicyType(type) {
    switch (type) {
        case 'queue':
            return '<span style="color: var(--accent-blue);">📋 Queue-based</span>';
        case 'metric':
            return '<span style="color: var(--accent-green);">📊 Metric-based</span>';
        case 'schedule':
            return '<span style="color: #FFC107;">⏰ Scheduled</span>';
        case 'none':
            return '<span style="color: var(--text-muted);">⚙️ Manual</span>';
        default:
            return '<span style="color: var(--text-muted);">❓ Unknown</span>';
    }
}

// Apply autoscale filters
function applyAutoscaleFilters() {
    const searchInput = document.getElementById('autoscale-search-input');
    const statusFilter = document.getElementById('autoscale-status-filter');

    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
    const statusValue = statusFilter ? statusFilter.value : '';

    let filtered = allAutoscaleGroupsCache.filter(group => {
        // Search filter
        if (searchTerm) {
            const name = (group.group_name || '').toLowerCase();
            const id = group.autoscale_group_id.toLowerCase();
            if (!name.includes(searchTerm) && !id.includes(searchTerm)) {
                return false;
            }
        }

        // Status filter
        if (statusValue && group.status !== statusValue) {
            return false;
        }

        return true;
    });

    renderAutoscaleGroupsTable(filtered);
}

// Clear autoscale filters
function clearAutoscaleFilters() {
    const searchInput = document.getElementById('autoscale-search-input');
    const statusFilter = document.getElementById('autoscale-status-filter');

    if (searchInput) searchInput.value = '';
    if (statusFilter) statusFilter.value = '';

    applyAutoscaleFilters();
}

// ═══════════════════════════════════════════════════════════════
// Autoscale Group Actions (Phase 2 - Issue #127)
// ═══════════════════════════════════════════════════════════════

function renderGroupActions(group) {
    const id = group.autoscale_group_id;
    const status = group.status;
    let html = '';
    if (status === 'active') {
        html += `<button class="btn-action" onclick="pauseGroup('${id}')" title="Pause">⏸</button>`;
    } else if (status === 'paused') {
        html += `<button class="btn-action" onclick="resumeGroup('${id}')" title="Resume">▶</button>`;
    }
    if (status !== 'terminated') {
        html += `<button class="btn-action btn-danger" onclick="terminateGroup('${id}', ${group.current_capacity})" title="Terminate">✕</button>`;
    }
    return html;
}

async function pauseGroup(id) {
    try {
        const response = await fetch(`https://api.spore.host/api/autoscale-groups/${id}/pause`, {
            method: 'POST', headers: getAPIHeaders(), credentials: 'include'
        });
        const data = await response.json();
        if (data.success) {
            showNotification('Group paused', 'success');
            await loadAutoscaleGroups();
        } else {
            showNotification(data.error || 'Failed to pause group', 'error');
        }
    } catch (e) {
        showNotification(`Error: ${e.message}`, 'error');
    }
}

async function resumeGroup(id) {
    try {
        const response = await fetch(`https://api.spore.host/api/autoscale-groups/${id}/resume`, {
            method: 'POST', headers: getAPIHeaders(), credentials: 'include'
        });
        const data = await response.json();
        if (data.success) {
            showNotification(`Group resumed (desired: ${data.desired_capacity})`, 'success');
            await loadAutoscaleGroups();
        } else {
            showNotification(data.error || 'Failed to resume group', 'error');
        }
    } catch (e) {
        showNotification(`Error: ${e.message}`, 'error');
    }
}

async function terminateGroup(id, instanceCount) {
    const msg = instanceCount > 0
        ? `Terminate this group and its ${instanceCount} instance(s)? This cannot be undone.`
        : 'Terminate this autoscale group? This cannot be undone.';
    if (!confirm(msg)) return;
    try {
        const response = await fetch(`https://api.spore.host/api/autoscale-groups/${id}`, {
            method: 'DELETE', headers: getAPIHeaders(), credentials: 'include'
        });
        const data = await response.json();
        if (data.success) {
            showNotification(`Group terminated (${data.instances_terminated} instance(s) stopped)`, 'success');
            await loadAutoscaleGroups();
        } else {
            showNotification(data.error || 'Failed to terminate group', 'error');
        }
    } catch (e) {
        showNotification(`Error: ${e.message}`, 'error');
    }
}

function showNotification(msg, type) {
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ═══════════════════════════════════════════════════════════════
// Cost Charts (Phase 3 - Issue #126)
// ═══════════════════════════════════════════════════════════════

let costTrendChart = null;
let costBreakdownChart = null;

async function loadCostChart(days) {
    currentCostDays = days;

    // Update active button
    [7, 30, 90].forEach(d => {
        const btn = document.getElementById(`cost-btn-${d}d`);
        if (btn) {
            btn.style.borderColor = d === days ? 'var(--accent-blue)' : 'var(--border)';
            btn.style.color = d === days ? 'var(--accent-blue)' : 'var(--text-secondary)';
        }
    });

    const loading = document.getElementById('cost-chart-loading');
    const container = document.getElementById('cost-chart-container');
    const empty = document.getElementById('cost-chart-empty');

    if (loading) loading.style.display = 'block';
    if (container) container.style.display = 'none';
    if (empty) empty.style.display = 'none';

    try {
        const response = await fetch(`https://api.spore.host/api/cost-history?days=${days}`, {
            headers: getAPIHeaders(), credentials: 'include'
        });
        const data = await response.json();

        if (loading) loading.style.display = 'none';

        if (!data.success || !data.history || data.history.length === 0) {
            if (empty) empty.style.display = 'block';
            return;
        }

        if (container) container.style.display = 'block';

        const labels = data.history.map(p => formatChartDate(p.timestamp));
        const hourlyCosts = data.history.map(p => p.hourly_cost);
        const computeCosts = data.history.map(p => p.breakdown?.compute || 0);
        const networkCosts = data.history.map(p => p.breakdown?.network || 0);

        // Destroy existing charts
        if (costTrendChart) { costTrendChart.destroy(); costTrendChart = null; }
        if (costBreakdownChart) { costBreakdownChart.destroy(); costBreakdownChart = null; }

        const cc = getChartColors();

        // Line chart: hourly cost over time
        const trendCtx = document.getElementById('cost-trend-chart')?.getContext('2d');
        if (trendCtx) {
            costTrendChart = new Chart(trendCtx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [{
                        label: 'Hourly Cost ($)',
                        data: hourlyCosts,
                        borderColor: '#4fc3f7',
                        backgroundColor: 'rgba(79, 195, 247, 0.1)',
                        fill: true,
                        tension: 0.3,
                        pointRadius: 2
                    }]
                },
                options: {
                    responsive: true,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { ticks: { color: cc.text, callback: v => `$${v.toFixed(3)}` }, grid: { color: cc.grid } },
                        x: { ticks: { color: cc.text }, grid: { color: cc.grid } }
                    }
                }
            });
        }

        // Stacked area chart: compute vs network
        const breakdownCtx = document.getElementById('cost-breakdown-chart')?.getContext('2d');
        if (breakdownCtx) {
            costBreakdownChart = new Chart(breakdownCtx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        {
                            label: 'Compute',
                            data: computeCosts,
                            borderColor: '#66bb6a',
                            backgroundColor: 'rgba(102, 187, 106, 0.3)',
                            fill: true, tension: 0.3, pointRadius: 2
                        },
                        {
                            label: 'Network',
                            data: networkCosts,
                            borderColor: '#f44336',
                            backgroundColor: 'rgba(244, 67, 54, 0.3)',
                            fill: true, tension: 0.3, pointRadius: 2
                        }
                    ]
                },
                options: {
                    responsive: true,
                    plugins: { legend: { position: 'bottom', labels: { color: cc.text } } },
                    scales: {
                        y: { stacked: true, ticks: { color: cc.text, callback: v => `$${v.toFixed(3)}` }, grid: { color: cc.grid } },
                        x: { ticks: { color: cc.text }, grid: { color: cc.grid } }
                    }
                }
            });
        }
    } catch (e) {
        if (loading) loading.style.display = 'none';
        if (empty) { empty.style.display = 'block'; empty.textContent = `Error loading chart: ${e.message}`; }
    }
}

function formatChartDate(ts) {
    const d = new Date(ts);
    return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:00`;
}

// ═══════════════════════════════════════════════════════════════
// Alert Preferences (Phase 4 - Issue #128)
// ═══════════════════════════════════════════════════════════════

async function loadAlertPreferences() {
    const loading = document.getElementById('alert-prefs-loading');
    if (loading) loading.style.display = 'block';

    try {
        const response = await fetch('https://api.spore.host/api/alert-preferences', {
            headers: getAPIHeaders(), credentials: 'include'
        });
        const data = await response.json();
        if (loading) loading.style.display = 'none';

        if (data.success && data.preferences) {
            const p = data.preferences;
            const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
            const setCheck = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

            setCheck('alerts-enabled', p.enabled);
            setVal('alert-email', p.notification_email);
            setVal('alert-hourly', p.cost_threshold_hourly);
            setVal('alert-daily', p.cost_threshold_daily);
            setVal('alert-instance-count', p.instance_count_threshold);
            setVal('alert-queue-high', p.queue_depth_high);
        }
    } catch (e) {
        if (loading) loading.style.display = 'none';
        console.error('Failed to load alert preferences:', e);
    }
}

async function saveAlertPreferences(event) {
    event.preventDefault();
    const getVal = id => { const el = document.getElementById(id); return el ? el.value : ''; };
    const getCheck = id => { const el = document.getElementById(id); return el ? el.checked : false; };
    const getNum = id => { const v = parseFloat(getVal(id)); return isNaN(v) ? 0 : v; };
    const getInt = id => { const v = parseInt(getVal(id)); return isNaN(v) ? 0 : v; };

    const prefs = {
        enabled: getCheck('alerts-enabled'),
        notification_email: getVal('alert-email'),
        cost_threshold_hourly: getNum('alert-hourly'),
        cost_threshold_daily: getNum('alert-daily'),
        instance_count_threshold: getInt('alert-instance-count'),
        queue_depth_high: getInt('alert-queue-high')
    };

    try {
        const response = await fetch('https://api.spore.host/api/alert-preferences', {
            method: 'POST',
            headers: getAPIHeaders(),
            credentials: 'include',
            body: JSON.stringify(prefs)
        });
        const data = await response.json();
        if (data.success) {
            showNotification('Alert preferences saved', 'success');
        } else {
            showNotification(data.error || 'Failed to save preferences', 'error');
        }
    } catch (e) {
        showNotification(`Error: ${e.message}`, 'error');
    }
}

// ═══════════════════════════════════════════════════════════════
// Queue Depth Gauge (Phase 5 - Issue #129)
// ═══════════════════════════════════════════════════════════════

function renderQueueDepthGauge(container, queueDepth, threshold) {
    if (typeof Chart === 'undefined') {
        // Fallback: numeric display
        container.innerHTML = `<div style="font-size: 1.4rem; font-weight: bold;">${queueDepth}</div><div style="font-size: 0.8rem; color: var(--text-muted);">messages</div>`;
        return;
    }

    const ratio = threshold > 0 ? queueDepth / threshold : 0;
    const color = ratio < 0.5 ? '#66bb6a' : ratio < 0.8 ? '#FFC107' : '#f44336';
    const remaining = Math.max(0, 1 - ratio);
    const gaugeId = `gauge-${Date.now()}`;

    container.innerHTML = `
        <div style="position: relative; display: inline-block;">
            <canvas id="${gaugeId}" width="120" height="70"></canvas>
            <div style="position: absolute; bottom: 5px; left: 0; right: 0; text-align: center;">
                <span style="font-size: 1.1rem; font-weight: bold; color: ${color};">${queueDepth}</span>
                <span style="font-size: 0.75rem; color: var(--text-muted);">/ ${threshold}</span>
            </div>
        </div>`;

    const ctx = document.getElementById(gaugeId)?.getContext('2d');
    if (!ctx) return;

    new Chart(ctx, {
        type: 'doughnut',
        data: {
            datasets: [{
                data: [ratio > 1 ? 1 : ratio, ratio > 1 ? 0 : remaining],
                backgroundColor: [color, getChartColors().empty],
                borderWidth: 0
            }]
        },
        options: {
            circumference: 180,
            rotation: -90,
            responsive: false,
            cutout: '75%',
            plugins: { legend: { display: false }, tooltip: { enabled: false } }
        }
    });
}

// Auto-refresh sweeps (every 10 seconds if on sweeps tab)
setInterval(() => {
    if (currentDashboardTab === 'sweeps' && document.getElementById('sweeps-tab-content').style.display !== 'none') {
        loadSweeps();
    } else if (currentDashboardTab === 'autoscale' && document.getElementById('autoscale-tab-content').style.display !== 'none') {
        loadAutoscaleGroups();
        loadCostSummary();
    }
}, 10000);

// ═══════════════════════════════════════════════════════════════
// Hamburger Menu (Mobile Navigation)
// ═══════════════════════════════════════════════════════════════

(function initHamburgerMenu() {
    const btn = document.getElementById('hamburger-btn');
    if (!btn) return;
    const nav = btn.closest('.nav');
    if (!nav) return;

    btn.addEventListener('click', function () {
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        nav.classList.toggle('nav-open');
    });

    // Close menu when a nav link is clicked
    nav.querySelectorAll('.nav-links a, .nav-links button').forEach(function (el) {
        el.addEventListener('click', function () {
            nav.classList.remove('nav-open');
            btn.setAttribute('aria-expanded', 'false');
        });
    });

    // Close menu on outside click
    document.addEventListener('click', function (e) {
        if (!nav.contains(e.target)) {
            nav.classList.remove('nav-open');
            btn.setAttribute('aria-expanded', 'false');
        }
    });
})();

// ═══════════════════════════════════════════════════════════════
// Keyboard Shortcuts (Dashboard)
// ═══════════════════════════════════════════════════════════════

(function initKeyboardShortcuts() {
    if (typeof switchDashboardTab !== 'function') return;

    const tabOrder = ['instances', 'sweeps', 'autoscale', 'settings'];
    let gPressed = false;
    let gTimer = null;

    function showShortcutsModal() {
        const existing = document.getElementById('shortcuts-modal');
        if (existing) { existing.remove(); return; }

        const modal = document.createElement('div');
        modal.id = 'shortcuts-modal';
        modal.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:2rem;z-index:9998;min-width:300px;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
        modal.innerHTML = `
            <h3 style="margin-bottom:1rem;color:var(--accent-blue);">Keyboard Shortcuts</h3>
            <table style="border-collapse:collapse;width:100%;">
                <tr><td style="padding:0.4rem 1rem 0.4rem 0;color:var(--text-muted);font-family:monospace;">g i</td><td>Switch to Instances tab</td></tr>
                <tr><td style="padding:0.4rem 1rem 0.4rem 0;color:var(--text-muted);font-family:monospace;">g s</td><td>Switch to Sweeps tab</td></tr>
                <tr><td style="padding:0.4rem 1rem 0.4rem 0;color:var(--text-muted);font-family:monospace;">g a</td><td>Switch to Autoscale tab</td></tr>
                <tr><td style="padding:0.4rem 1rem 0.4rem 0;color:var(--text-muted);font-family:monospace;">r</td><td>Refresh current tab</td></tr>
                <tr><td style="padding:0.4rem 1rem 0.4rem 0;color:var(--text-muted);font-family:monospace;">/</td><td>Focus search/filter</td></tr>
                <tr><td style="padding:0.4rem 1rem 0.4rem 0;color:var(--text-muted);font-family:monospace;">?</td><td>Toggle this help</td></tr>
            </table>
            <p style="margin-top:1rem;font-size:0.85rem;color:var(--text-muted);">Press <kbd style="background:var(--bg-dark);padding:0.1rem 0.4rem;border-radius:3px;font-family:monospace;">Esc</kbd> or <kbd style="background:var(--bg-dark);padding:0.1rem 0.4rem;border-radius:3px;font-family:monospace;">?</kbd> to close</p>`;

        const backdrop = document.createElement('div');
        backdrop.id = 'shortcuts-backdrop';
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9997;';
        backdrop.addEventListener('click', function () { modal.remove(); backdrop.remove(); });

        document.body.appendChild(backdrop);
        document.body.appendChild(modal);
    }

    document.addEventListener('keydown', function (e) {
        // Skip if typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
            if (e.key === 'Escape') { e.target.blur(); }
            return;
        }

        // Escape: close modal
        if (e.key === 'Escape') {
            const modal = document.getElementById('shortcuts-modal');
            const backdrop = document.getElementById('shortcuts-backdrop');
            if (modal) modal.remove();
            if (backdrop) backdrop.remove();
            return;
        }

        // ? — toggle shortcuts help
        if (e.key === '?') {
            e.preventDefault();
            showShortcutsModal();
            return;
        }

        // r — refresh current tab
        if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            if (typeof refreshCurrentDashboardView === 'function') {
                refreshCurrentDashboardView();
            }
            return;
        }

        // / — focus filter input
        if (e.key === '/') {
            e.preventDefault();
            const filter = document.getElementById('filter-input') ||
                           document.querySelector('input[type="search"]') ||
                           document.querySelector('input[placeholder*="filter" i]') ||
                           document.querySelector('input[placeholder*="search" i]');
            if (filter) filter.focus();
            return;
        }

        // g + key — tab navigation
        if (e.key === 'g' && !gPressed) {
            gPressed = true;
            clearTimeout(gTimer);
            gTimer = setTimeout(function () { gPressed = false; }, 1000);
            return;
        }

        if (gPressed) {
            gPressed = false;
            clearTimeout(gTimer);
            if (e.key === 'i') { e.preventDefault(); switchDashboardTab('instances'); }
            else if (e.key === 's') { e.preventDefault(); switchDashboardTab('sweeps'); }
            else if (e.key === 'a') { e.preventDefault(); switchDashboardTab('autoscale'); }
        }
    });
})();

// ═══════════════════════════════════════════════════════════════
// Swipeable Tabs (Mobile Touch)
// ═══════════════════════════════════════════════════════════════

(function initSwipeableTabs() {
    if (typeof switchDashboardTab !== 'function') return;

    const tabOrder = ['instances', 'sweeps', 'autoscale'];
    let touchStartX = 0;
    let touchStartY = 0;

    const mainContent = document.querySelector('.container') || document.body;

    mainContent.addEventListener('touchstart', function (e) {
        touchStartX = e.changedTouches[0].clientX;
        touchStartY = e.changedTouches[0].clientY;
    }, { passive: true });

    mainContent.addEventListener('touchend', function (e) {
        const deltaX = e.changedTouches[0].clientX - touchStartX;
        const deltaY = e.changedTouches[0].clientY - touchStartY;

        // Require horizontal swipe > 50px and more horizontal than vertical
        if (Math.abs(deltaX) < 50 || Math.abs(deltaY) > Math.abs(deltaX)) return;

        const currentIdx = tabOrder.indexOf(
            typeof currentDashboardTab !== 'undefined' ? currentDashboardTab : 'instances'
        );
        if (currentIdx === -1) return;

        if (deltaX < 0 && currentIdx < tabOrder.length - 1) {
            // Swipe left → next tab
            switchDashboardTab(tabOrder[currentIdx + 1]);
        } else if (deltaX > 0 && currentIdx > 0) {
            // Swipe right → previous tab
            switchDashboardTab(tabOrder[currentIdx - 1]);
        }
    }, { passive: true });
})();

// ═══════════════════════════════════════════════════════════════
// Team Management
// ═══════════════════════════════════════════════════════════════

const TEAMS_API = 'https://api.spore.host/teams';

// Initialize team selector after authentication
async function initTeamSelector() {
    const selector = document.getElementById('team-selector');
    const manageBtn = document.getElementById('manage-teams-btn');
    if (!selector) return;

    try {
        const response = await fetch(TEAMS_API, {
            headers: getAPIHeaders(),
            credentials: 'include'
        });
        if (!response.ok) return;
        const data = await response.json();
        const teams = data.teams || [];

        // Rebuild options
        selector.innerHTML = '<option value="">Personal</option>';
        teams.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.team_id;
            opt.textContent = t.team_name + (t.role === 'owner' ? ' (owner)' : '');
            selector.appendChild(opt);
        });

        // Restore previous selection
        const saved = sessionStorage.getItem('selectedTeamId');
        if (saved) selector.value = saved;

        selector.style.display = '';
        if (manageBtn) manageBtn.style.display = '';
    } catch (e) {
        console.warn('Could not load teams:', e);
    }
}

// Called when user changes team selector
function onTeamSelectorChange(teamId) {
    if (teamId) {
        sessionStorage.setItem('selectedTeamId', teamId);
    } else {
        sessionStorage.removeItem('selectedTeamId');
    }
    // Refresh current view with new team context
    refreshCurrentDashboardView();
}

// ── Team modal ────────────────────────────────────────────────

function openTeamModal() {
    modalPreviousFocus = document.activeElement;
    const modal = document.getElementById('team-modal');
    const backdrop = document.getElementById('team-modal-backdrop');
    if (modal) modal.style.display = '';
    if (backdrop) backdrop.style.display = '';

    // Hide background from screen readers
    const nav = document.querySelector('nav');
    const container = document.querySelector('.container');
    if (nav) nav.setAttribute('aria-hidden', 'true');
    if (container) container.setAttribute('aria-hidden', 'true');

    // Focus first input and trap focus
    const nameInput = document.getElementById('new-team-name');
    if (nameInput) setTimeout(() => nameInput.focus(), 50);
    document.addEventListener('keydown', modalEscapeHandler);
    document.addEventListener('keydown', trapFocusInModal);

    loadTeamList();
}

function closeTeamModal() {
    const modal = document.getElementById('team-modal');
    const backdrop = document.getElementById('team-modal-backdrop');
    if (modal) modal.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';

    // Restore background
    const nav = document.querySelector('nav');
    const container = document.querySelector('.container');
    if (nav) nav.removeAttribute('aria-hidden');
    if (container) container.removeAttribute('aria-hidden');

    // Remove listeners and restore focus
    document.removeEventListener('keydown', modalEscapeHandler);
    document.removeEventListener('keydown', trapFocusInModal);
    if (modalPreviousFocus) modalPreviousFocus.focus();
}

async function createTeam() {
    const nameEl = document.getElementById('new-team-name');
    const descEl = document.getElementById('new-team-desc');
    const errEl = document.getElementById('team-create-error');
    const name = (nameEl && nameEl.value.trim()) || '';
    if (!name) {
        if (errEl) { errEl.textContent = 'Team name is required.'; errEl.style.display = ''; }
        return;
    }
    if (errEl) errEl.style.display = 'none';
    try {
        const r = await fetch(TEAMS_API, {
            method: 'POST',
            headers: getAPIHeaders(),
            credentials: 'include',
            body: JSON.stringify({ team_name: name, description: descEl ? descEl.value.trim() : '' })
        });
        const data = await r.json();
        if (!r.ok || !data.success) throw new Error(data.error || 'Create failed');
        if (nameEl) nameEl.value = '';
        if (descEl) descEl.value = '';
        await loadTeamList();
        await initTeamSelector();
    } catch (e) {
        if (errEl) { errEl.textContent = e.message; errEl.style.display = ''; }
    }
}

async function loadTeamList() {
    const container = document.getElementById('team-list-container');
    const loading = document.getElementById('team-list-loading');
    if (!container) return;
    if (loading) loading.style.display = '';
    container.innerHTML = '';
    try {
        const r = await fetch(TEAMS_API, { headers: getAPIHeaders(), credentials: 'include' });
        const data = await r.json();
        if (loading) loading.style.display = 'none';
        const teams = data.teams || [];
        if (teams.length === 0) {
            container.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">No teams yet.</p>';
            return;
        }
        teams.forEach(t => container.appendChild(renderTeamCard(t)));
    } catch (e) {
        if (loading) loading.style.display = 'none';
        container.innerHTML = `<p style="color:var(--accent-red,#ff6b6b);">Failed to load teams: ${escapeHtml(String(e))}</p>`;
    }
}

function renderTeamCard(team) {
    const card = document.createElement('div');
    card.className = 'team-card';
    card.dataset.teamId = team.team_id;

    const isOwner = team.role === 'owner';
    const badge = `<span class="member-role-badge ${isOwner ? 'owner' : ''}">${team.role}</span>`;

    card.innerHTML = `
        <div class="team-card-header" onclick="toggleTeamCard('${team.team_id}')">
            <div>
                <span class="team-card-title">${escapeHtml(team.team_name)}</span>${badge}
                <div class="team-card-meta">${escapeHtml(team.description || '')} &bull; ${team.member_count} member${team.member_count !== 1 ? 's' : ''}</div>
            </div>
            <div style="display:flex;gap:0.4rem;">
                ${isOwner ? `<button class="btn-danger" onclick="event.stopPropagation();deleteTeam('${team.team_id}')">Delete</button>` : ''}
            </div>
        </div>
        <div class="team-card-body" id="team-body-${team.team_id}" style="display:none;">
            <div class="member-list" id="members-${team.team_id}">
                <div style="color:var(--text-muted);font-size:0.85rem;">Loading members...</div>
            </div>
            ${isOwner ? `
            <div class="team-add-member-form">
                <input type="text" id="add-arn-${team.team_id}" placeholder="IAM ARN (arn:aws:iam::...)" class="team-input" style="flex:1;">
                <button class="btn-team-action" onclick="addMember('${team.team_id}')">Add</button>
            </div>
            <div id="add-member-error-${team.team_id}" class="team-error" style="display:none;"></div>
            ` : ''}
        </div>
    `;
    return card;
}

function toggleTeamCard(teamId) {
    const body = document.getElementById(`team-body-${teamId}`);
    if (!body) return;
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? '' : 'none';
    if (isHidden) loadTeamMembers(teamId);
}

async function loadTeamMembers(teamId) {
    const container = document.getElementById(`members-${teamId}`);
    if (!container) return;
    try {
        const r = await fetch(`${TEAMS_API}/${teamId}`, { headers: getAPIHeaders(), credentials: 'include' });
        const data = await r.json();
        const members = data.members || [];
        if (members.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;">No members.</div>';
            return;
        }
        container.innerHTML = '';
        members.forEach(m => {
            const row = document.createElement('div');
            row.className = 'member-row';
            const isOwnerRole = m.role === 'owner';
            row.innerHTML = `
                <span class="member-row-arn">${escapeHtml(m.member_arn)}</span>
                <div style="display:flex;align-items:center;gap:0.4rem;flex-shrink:0;">
                    <span class="member-role-badge ${isOwnerRole ? 'owner' : ''}">${m.role}</span>
                    ${!isOwnerRole ? `<button class="btn-danger" onclick="removeMember('${teamId}','${escapeHtml(m.member_arn)}')">Remove</button>` : ''}
                </div>
            `;
            container.appendChild(row);
        });
    } catch (e) {
        container.innerHTML = `<div style="color:var(--accent-red,#ff6b6b);font-size:0.85rem;">Failed: ${escapeHtml(String(e))}</div>`;
    }
}

async function addMember(teamId) {
    const input = document.getElementById(`add-arn-${teamId}`);
    const errEl = document.getElementById(`add-member-error-${teamId}`);
    const arn = (input && input.value.trim()) || '';
    if (!arn) {
        if (errEl) { errEl.textContent = 'ARN is required.'; errEl.style.display = ''; }
        return;
    }
    if (errEl) errEl.style.display = 'none';
    try {
        const r = await fetch(`${TEAMS_API}/${teamId}/members`, {
            method: 'POST',
            headers: getAPIHeaders(),
            credentials: 'include',
            body: JSON.stringify({ member_arn: arn })
        });
        const data = await r.json();
        if (!r.ok || !data.success) throw new Error(data.error || 'Add failed');
        if (input) input.value = '';
        loadTeamMembers(teamId);
        initTeamSelector();
    } catch (e) {
        if (errEl) { errEl.textContent = e.message; errEl.style.display = ''; }
    }
}

async function removeMember(teamId, memberArn) {
    if (!confirm(`Remove ${memberArn} from team?`)) return;
    try {
        const r = await fetch(`${TEAMS_API}/${teamId}/members/${encodeURIComponent(memberArn)}`, {
            method: 'DELETE',
            headers: getAPIHeaders(),
            credentials: 'include'
        });
        const data = await r.json();
        if (!r.ok || !data.success) throw new Error(data.error || 'Remove failed');
        loadTeamMembers(teamId);
        initTeamSelector();
    } catch (e) {
        alert(`Failed to remove member: ${e.message}`);
    }
}

async function deleteTeam(teamId) {
    if (!confirm('Delete this team and all its memberships?')) return;
    try {
        const r = await fetch(`${TEAMS_API}/${teamId}`, {
            method: 'DELETE',
            headers: getAPIHeaders(),
            credentials: 'include'
        });
        const data = await r.json();
        if (!r.ok || !data.success) throw new Error(data.error || 'Delete failed');
        // Clear selection if this was the selected team
        if (sessionStorage.getItem('selectedTeamId') === teamId) {
            sessionStorage.removeItem('selectedTeamId');
        }
        loadTeamList();
        initTeamSelector();
    } catch (e) {
        alert(`Failed to delete team: ${e.message}`);
    }
}

// ── Strata Software Environment ──────────────────────────────────────────────

let selectedStrataFormation = null;

async function loadStrataCatalog() {
    const loading = document.getElementById('strata-catalog-loading');
    const errDiv  = document.getElementById('strata-catalog-error');
    const grid    = document.getElementById('strata-catalog-grid');
    if (!loading || !grid) return;

    loading.style.display = 'block';
    errDiv.style.display  = 'none';
    grid.style.display    = 'none';

    try {
        const data = await DashboardAPI.get('/api/strata/catalog');
        loading.style.display = 'none';

        const formations = data.formations || [];
        grid.innerHTML = formations.map(f => `
            <div class="strata-card" id="strata-card-${CSS.escape(f.name)}"
                 onclick="selectStrataFormation(${JSON.stringify(f.name)})"
                 style="padding: 1rem; background: var(--bg-card); border: 2px solid var(--border-color); border-radius: 8px; cursor: pointer; transition: border-color 0.15s;">
                <div style="font-weight: 600; margin-bottom: 0.25rem;">${escapeHtml(f.display_name)}</div>
                <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.5rem;">${escapeHtml(f.description)}</div>
                <code style="font-size: 0.75rem; color: var(--text-secondary);">${escapeHtml(f.name)}</code>
            </div>`).join('');

        grid.style.display = 'grid';
    } catch (e) {
        loading.style.display = 'none';
        errDiv.textContent    = `Failed to load catalog: ${e.message}`;
        errDiv.style.display  = 'block';
    }
}

function selectStrataFormation(name) {
    selectedStrataFormation = name;

    // Highlight selected card
    document.querySelectorAll('.strata-card').forEach(el => {
        el.style.borderColor = 'var(--border-color)';
    });
    const card = document.getElementById(`strata-card-${CSS.escape(name)}`);
    if (card) card.style.borderColor = 'var(--accent-blue)';

    // Show launch flag banner
    const banner = document.getElementById('strata-selection-banner');
    const flag   = document.getElementById('strata-launch-flag');
    if (banner && flag) {
        flag.textContent  = `--strata-formation "${name}"`;
        banner.style.display = 'block';
    }
}

function copyStrataFlag() {
    if (!selectedStrataFormation) return;
    const text = `--strata-formation "${selectedStrataFormation}"`;
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.querySelector('#strata-selection-banner button');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy flag'; }, 1500); }
    });
}

// =============================================================================
// Lagotto Watches
// =============================================================================

let allWatchesCache = [];

async function loadWatches() {
    const tbody = document.getElementById('watches-tbody');
    const loadingDiv = document.getElementById('watches-loading');
    const errorDiv = document.getElementById('watches-error');
    const table = document.getElementById('watches-table');

    try {
        if (loadingDiv) loadingDiv.style.display = 'block';
        if (errorDiv) errorDiv.style.display = 'none';
        if (table) table.style.display = 'none';

        const response = await fetch('https://api.spore.host/api/watches', {
            method: 'GET',
            headers: getAPIHeaders(),
            credentials: 'include'
        });
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        const data = await response.json();

        if (loadingDiv) loadingDiv.style.display = 'none';

        if (data.success && data.watches && data.watches.length > 0) {
            allWatchesCache = data.watches;
            renderWatchesTable(data.watches);
            if (table) table.style.display = 'table';
        } else {
            allWatchesCache = [];
            if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:2rem; color:var(--text-muted);">No watches found. Create one with <code>lagotto watch</code></td></tr>';
            if (table) table.style.display = 'table';
        }

        loadWatchHistory();
    } catch (error) {
        if (loadingDiv) loadingDiv.style.display = 'none';
        if (errorDiv) {
            errorDiv.style.display = 'block';
            errorDiv.innerHTML = '<strong>Error:</strong> ' + escapeHtml(error.message);
        }
    }
}

function renderWatchesTable(watches) {
    const tbody = document.getElementById('watches-tbody');
    if (!tbody) return;

    tbody.innerHTML = watches.map(function(w) {
        var statusColors = {
            active: 'var(--accent-blue)',
            matched: '#22c55e',
            expired: 'var(--text-muted)',
            cancelled: '#ef4444'
        };
        var statusColor = statusColors[w.status] || 'var(--text-muted)';
        var regions = (w.regions && w.regions.length > 0) ? w.regions.join(', ') : 'all';
        var expires = w.expires_at ? new Date(w.expires_at).toLocaleString() : '-';

        return '<tr style="border-bottom: 1px solid var(--border);">' +
            '<td style="padding: 0.75rem;"><code>' + escapeHtml(w.watch_id) + '</code></td>' +
            '<td style="padding: 0.75rem; font-weight: 500;">' + escapeHtml(w.instance_type_pattern) + '</td>' +
            '<td style="padding: 0.75rem; font-size: 0.9rem;">' + escapeHtml(regions) + '</td>' +
            '<td style="padding: 0.75rem;"><span style="color: ' + statusColor + '; font-weight: 600;">' + escapeHtml(w.status) + '</span></td>' +
            '<td style="padding: 0.75rem;">' + (w.spot ? 'Yes' : 'No') + '</td>' +
            '<td style="padding: 0.75rem;">' + escapeHtml(w.action) + '</td>' +
            '<td style="padding: 0.75rem;">' + (w.match_count || 0) + '</td>' +
            '<td style="padding: 0.75rem; font-size: 0.85rem;">' + expires + '</td>' +
            '</tr>';
    }).join('');
}

async function loadWatchHistory() {
    const tbody = document.getElementById('watches-history-tbody');
    const section = document.getElementById('watches-history-section');
    if (!tbody || !section) return;

    try {
        const response = await fetch('https://api.spore.host/api/watches/history', {
            method: 'GET',
            headers: getAPIHeaders(),
            credentials: 'include'
        });
        if (!response.ok) return;
        const data = await response.json();

        if (data.success && data.matches && data.matches.length > 0) {
            section.style.display = 'block';
            tbody.innerHTML = data.matches.map(function(m) {
                var matchedAt = m.matched_at ? new Date(m.matched_at).toLocaleString() : '-';
                var price = m.price ? '$' + m.price.toFixed(4) + '/hr' : '-';
                return '<tr style="border-bottom: 1px solid var(--border);">' +
                    '<td style="padding: 0.75rem;"><code>' + escapeHtml(m.instance_type) + '</code></td>' +
                    '<td style="padding: 0.75rem;">' + escapeHtml(m.region) + '</td>' +
                    '<td style="padding: 0.75rem;">' + escapeHtml(m.availability_zone) + '</td>' +
                    '<td style="padding: 0.75rem;">' + price + '</td>' +
                    '<td style="padding: 0.75rem;">' + escapeHtml(m.action_taken) + '</td>' +
                    '<td style="padding: 0.75rem; font-size: 0.85rem;">' + matchedAt + '</td>' +
                    '</tr>';
            }).join('');
        } else {
            section.style.display = 'none';
        }
    } catch (error) {
        console.error('Failed to load watch history:', error);
    }
}

// =============================================================================
// Slack OAuth post-install handler
// =============================================================================

(function handleSlackOAuthReturn() {
    const params = new URLSearchParams(window.location.search);
    const statusEl = document.getElementById('slack-oauth-status');
    if (!statusEl) return;

    if (params.get('bot') === 'connected') {
        const workspaceName = params.get('workspace_name') || params.get('workspace') || 'your workspace';
        // nosemgrep: javascript.browser.security.raw-html-concat.raw-html-concat
        statusEl.innerHTML =
            '<div style="padding:0.75rem 1rem;background:rgba(34,197,94,0.12);border:1px solid #22c55e;border-radius:6px;color:#22c55e;font-size:0.9rem;">' +
            '✅ <strong>Slack connected</strong> — spore-bot is now installed in <strong>' + escapeHtml(decodeURIComponent(workspaceName)) + '</strong>.<br>' +
            '<span style="color:var(--text-muted);font-size:0.85rem;">Next: run <code>spawn bot register</code> to grant access to your collaborators.</span>' +
            '</div>';
        // Switch to settings tab to show the success message
        if (typeof switchDashboardTab === 'function') switchDashboardTab('settings');
        // Clean up URL
        window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('error')) {
        statusEl.innerHTML =
            '<div style="padding:0.75rem 1rem;background:rgba(239,68,68,0.12);border:1px solid #ef4444;border-radius:6px;color:#ef4444;font-size:0.9rem;">' +
            '❌ Slack connection was cancelled or failed. <a href="#" onclick="document.getElementById(\'slack-oauth-status\').innerHTML=\'\'" style="color:inherit;">Dismiss</a>' +
            '</div>';
        if (typeof switchDashboardTab === 'function') switchDashboardTab('settings');
        window.history.replaceState({}, '', window.location.pathname);
    }
})();

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DashboardAPI, showTab };
}
