import { Navigate, useLocation, useParams } from "react-router-dom";

function InventoryRedirect() {
  const { id = "demo" } = useParams<{ id: string }>();
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: `/p/${id}/products`, search, hash }} />;
}

export const route = {
  path: "/p/:id/inventory",
  element: <InventoryRedirect />,
};
