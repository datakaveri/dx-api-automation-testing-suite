pipeline {
  environment {
    devRegistry = 'ghcr.io/datakaveri/iudx-qa-automation'
    registryCredential = 'datakaveri-ghcr'
    kubeCredential = 'iudx-qa-automation-deployer-kubeconfig'
    kubectl = '/home/ubuntu/dap-ui/bin/kubectl'
    namespace = 'iudx-qa-automation'
    appUrl = 'https://v2.dev.iudx.io/qa-automation'
    basePath = '/qa-automation/'
    keycloakUrl = 'https://v2.dev.iudx.io/auth'
    keycloakRealm = 'iudx-v2'
    keycloakClientId = 'frontend-client'
    GIT_HASH = GIT_COMMIT.take(7)
  }

  agent {
    node {
      label 'slave1'
    }
  }

  triggers {
    pollSCM('H/5 * * * *')
  }

  options {
    timeout(time: 60, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  stages {

    stage('Unit Tests') {
      steps {
        script {
          sh '''
            docker run --rm -v "$WORKSPACE/backend":/src:ro node:22-slim \
              sh -c 'cp -r /src /app && cd /app && npm ci --no-audit --no-fund && npm test'
          '''
        }
      }
    }

    stage('Trivy Code Scan (Dependencies)') {
      steps {
        script {
          sh '''
            trivy fs --scanners vuln,secret,misconfig --output trivy-fs-report.txt .
          '''
        }
      }
    }

    stage('Building images') {
      steps {
        script {
          echo 'Pulled - ' + env.GIT_BRANCH
          env.BACKEND_IMAGE = "${devRegistry}:backend-${env.GIT_HASH}"
          env.FRONTEND_IMAGE = "${devRegistry}:frontend-${env.GIT_HASH}"
          currentBuild.description = "backend-${env.GIT_HASH}, frontend-${env.GIT_HASH}"
          sh "docker build --pull -t ${env.BACKEND_IMAGE} ./backend"
          sh """
            docker build --pull -t ${env.FRONTEND_IMAGE} \\
              --build-arg BASE_PATH=${basePath} \\
              --build-arg VITE_KEYCLOAK_URL=${keycloakUrl} \\
              --build-arg VITE_KEYCLOAK_REALM=${keycloakRealm} \\
              --build-arg VITE_KEYCLOAK_CLIENT_ID=${keycloakClientId} \\
              --build-arg VITE_API_BASE_URL=${appUrl} \\
              ./frontend
          """
        }
      }
    }

    stage('Trivy Scan and Report') {
      steps {
        script {
          sh "trivy image --output trivy-backend-image-report.txt ${env.BACKEND_IMAGE}"
          sh "trivy image --output trivy-frontend-image-report.txt ${env.FRONTEND_IMAGE}"
          catchError(buildResult: 'UNSTABLE', stageResult: 'UNSTABLE',
                     message: 'Trivy found fixable HIGH/CRITICAL vulnerabilities - see trivy-*-image-report.txt') {
            sh """
            trivy image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed ${env.BACKEND_IMAGE}
            trivy image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed ${env.FRONTEND_IMAGE}
            """
          }
        }
      }
      post {
        always {
          archiveArtifacts artifacts: 'trivy-*.txt', allowEmptyArchive: true
        }
      }
    }

    stage('Push Images') {
      steps {
        withCredentials([usernamePassword(credentialsId: registryCredential, usernameVariable: 'GH_USER', passwordVariable: 'GH_TOKEN')]) {
          script {
            sh """
              set +x
              trap 'docker logout ghcr.io' EXIT
              echo "\$GH_TOKEN" | docker login ghcr.io -u "\$GH_USER" --password-stdin
              docker push ${env.BACKEND_IMAGE}
              docker push ${env.FRONTEND_IMAGE}
            """
          }
        }
      }
    }

    stage('EKS deployment') {
      steps {
        withCredentials([file(credentialsId: kubeCredential, variable: 'KUBECONFIG')]) {
          script {
            sh """
              for app in backend frontend; do
                if [ "\$app" = backend ]; then image=${env.BACKEND_IMAGE}; else image=${env.FRONTEND_IMAGE}; fi
                ${kubectl} -n ${namespace} set image deployment/\$app \$app=\$image
                ${kubectl} -n ${namespace} rollout status deployment/\$app --timeout=5m || {
                  ${kubectl} -n ${namespace} rollout undo deployment/\$app
                  exit 1
                }
              done
            """
          }
        }
      }
      post {
        failure {
          error "Failed to deploy images to EKS"
        }
      }
    }

    stage('Smoke Test') {
      steps {
        script {
          sh """
            sleep 5
            for path in / /health; do
              CODE=\$(curl -s -o /dev/null -m 20 -w '%{http_code}' "${appUrl}\$path")
              echo "GET ${appUrl}\$path -> \$CODE"
              [ "\$CODE" = 200 ] || { echo "Smoke test failed"; exit 1; }
            done
          """
        }
      }
    }

  }

  post {
    always {
      script {
        sh "docker rmi ${env.BACKEND_IMAGE ?: 'none'} ${env.FRONTEND_IMAGE ?: 'none'} || true"
      }
    }
  }
}
