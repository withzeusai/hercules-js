import { useEffect } from "react";
import { useAuth } from "react-oidc-context";

export default function AuthCallback() {
  const { isLoading, isAuthenticated, error } = useAuth();

  useEffect(() => {
    // Redirect to home after auth completes
    if (!isLoading && isAuthenticated) {
      window.history.replaceState({}, document.title, "/");
    }
    // Handle auth errors
    else if (!isLoading && error) {
      console.error("Authentication error:", error);
      window.history.replaceState({}, document.title, "/");
    }
    // Handle auth cancellation/failure
    else if (!isLoading && !isAuthenticated && !error) {
      console.warn(
        "Authentication completed without success or explicit error",
      );
      window.history.replaceState({}, document.title, "/");
    }
  }, [isLoading, isAuthenticated, error]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
      }}
    >
      Loading...
    </div>
  );
}
