// Security validation script for PhasePad build
const fs = require('fs');
const path = require('path');

const DANGEROUS_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /\.env/,
  /credentials/i
];

const DANGEROUS_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  'credentials.json',
  'secrets.json',
  '*.p12',
  '*.key',
  '*.pem'
];

function scanForSecrets(dir) {
  const issues = [];
  
  function scanDirectory(currentDir) {
    const items = fs.readdirSync(currentDir, { withFileTypes: true });
    
    for (const item of items) {
      const itemPath = path.join(currentDir, item.name);
      const relativePath = path.relative(process.cwd(), itemPath);
      
      // Skip node_modules and build directories
      if (item.name === 'node_modules' || item.name === 'dist' || item.name === 'build') {
        continue;
      }
      
      if (item.isDirectory()) {
        scanDirectory(itemPath);
      } else {
        // Check filename against dangerous patterns
        for (const pattern of DANGEROUS_FILES) {
          // Use global replacement to handle all asterisks in the pattern
          const regexPattern = pattern.replace(/\*/g, '.*');
          if (item.name.match(regexPattern)) {
            issues.push({
              type: 'dangerous_file',
              path: relativePath,
              issue: `Potentially sensitive file: ${item.name}`
            });
          }
        }
        
        // Check file content for secrets (only text files)
        if (item.name.match(/\.(js|json|md|txt|env)$/)) {
          try {
            const content = fs.readFileSync(itemPath, 'utf8');
            for (const pattern of DANGEROUS_PATTERNS) {
              if (pattern.test(content)) {
                issues.push({
                  type: 'potential_secret',
                  path: relativePath,
                  issue: `Potential secret detected matching: ${pattern.source}`
                });
              }
            }
          } catch (error) {
            // Skip files we can't read
          }
        }
      }
    }
  }
  
  scanDirectory(dir);
  return issues;
}

function validatePackageJson() {
  const issues = [];
  const packagePath = path.join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  
  // Check for missing security fields
  if (!packageJson.build?.win?.publisherName) {
    issues.push({
      type: 'missing_config',
      issue: 'Missing publisher name in build config'
    });
  }
  
  if (packageJson.build?.win?.verifyUpdateCodeSignature === false) {
    issues.push({
      type: 'security_warning',
      issue: 'Update code signing verification is disabled'
    });
  }
  
  return issues;
}

function runSecurityCheck() {
  console.log('🔍 Running PhasePad security scan...\n');
  
  const secretIssues = scanForSecrets(process.cwd());
  const configIssues = validatePackageJson();
  const allIssues = [...secretIssues, ...configIssues];
  
  if (allIssues.length === 0) {
    console.log('✅ No security issues found!');
    return;
  }
  
  console.log('⚠️  Security issues detected:\n');
  
  for (const issue of allIssues) {
    console.log(`${issue.type === 'dangerous_file' ? '🔴' : '🟡'} ${issue.issue}`);
    if (issue.path) {
      console.log(`   Path: ${issue.path}`);
    }
    console.log('');
  }
  
  console.log(`Found ${allIssues.length} potential issues.`);
  console.log('Please review these before building for production.');
}

if (require.main === module) {
  runSecurityCheck();
}

module.exports = { runSecurityCheck };