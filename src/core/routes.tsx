// routes.tsx
import React from "react";
import Home from 'app/packages/core/pages/Home/index'
const { json, useLoaderData } = require("react-router-dom");

export default [
  {
    path: "/",
    element: <Home />,
    default: Home,
    loader() {
      return json({ message: "Welcome to React Router!" });
    },
    Component() {
      let data = useLoaderData();
      return <h1>{data.message}</h1>;
    }
  },
];
