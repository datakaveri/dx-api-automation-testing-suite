interface LoginPageProps {
  onLogin: () => void;
  error?: string | null;
}

export function LoginPage({ onLogin, error }: Readonly<LoginPageProps>) {
  return (
    <div className="login">
      <div className="modal">
        <div>
          <h2>API Testing Platform</h2>
          <p>Sign in with your IUDX account.</p>
        </div>
        {error && <div role="alert" className="alert m-0">{error}</div>}
        <button type="button" onClick={onLogin} className="btn btn-primary">
          Sign in with Keycloak
        </button>
      </div>
    </div>
  );
}
