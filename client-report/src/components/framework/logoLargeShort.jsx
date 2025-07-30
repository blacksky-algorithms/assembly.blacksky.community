// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";

const PolisLogo = ({ invert = false }) => {
  const styles = {
    link: {
      textDecoration: "none",
      cursor: "pointer",
      padding: "8px 0px 4px 10px",
    },
  };

  const svgContent = (
    <svg width="66" height="57" viewBox="0 0 66 57" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M34.4307 33.4412C34.4307 36.9545 37.2796 39.8025 40.793 39.8025H47.8867V26.3474H47.8877V56.2234H47.8867V42.9958H40.793C37.2796 42.9958 34.4307 45.8438 34.4307 49.3572V56.2234H31.4668V49.3572C31.4668 45.8438 28.6188 42.9958 25.1055 42.9958H18.0117V39.8025H25.1055C28.6188 39.8025 31.4668 36.9545 31.4668 33.4412V26.3474H34.4307V33.4412Z" fill="black"/>
      <path d="M39.5461 7.37392C37.0618 9.85825 37.0618 13.8861 39.5461 16.3705L44.5622 21.3866L42.3045 23.6444L37.2883 18.6282C34.804 16.1439 30.7761 16.1439 28.2918 18.6282L23.437 23.483L21.3404 21.3864L26.1952 16.5316C28.6795 14.0473 28.6795 10.0194 26.1952 7.5351L21.1792 2.51911L23.437 0.261353L28.4531 5.2775C30.9374 7.7618 34.9653 7.76182 37.4496 5.2775L42.4658 0.261353L44.5622 2.35778L39.5461 7.37392Z" fill="black"/>
      <path d="M18.2848 17.4248C17.3754 20.8185 19.3894 24.3067 22.783 25.2161L29.6352 27.0521L28.8089 30.136L21.9569 28.3001C18.5633 27.3907 15.075 29.4047 14.1657 32.7983L12.3886 39.4303L9.52464 38.6629L11.3016 32.0311C12.211 28.6375 10.197 25.1492 6.80335 24.2399L-0.0488281 22.4039L0.77757 19.3197L7.62975 21.1558C11.0234 22.0651 14.5116 20.0511 15.421 16.6575L17.257 9.8053L20.1208 10.5726L18.2848 17.4248Z" fill="black"/>
      <path d="M50.5243 16.5221C51.4336 19.9157 54.9219 21.9297 58.3155 21.0204L65.1677 19.1843L65.994 22.2683L59.1418 24.1043C55.7482 25.0136 53.7343 28.5019 54.6436 31.8956L56.4206 38.5276L53.5569 39.2949L51.7799 32.6631C50.8705 29.2695 47.3823 27.2555 43.9886 28.1648L37.1365 30.0009L36.3101 26.9167L43.1622 25.0807C46.5559 24.1714 48.5698 20.6831 47.6605 17.2895L45.8245 10.4373L48.6882 9.66992L50.5243 16.5221Z" fill="black"/>
    </svg>
  );

  return (
    <a style={styles.link} href="https//assembly.blacksky.community">
      {svgContent}
    </a>
  );
};

export default PolisLogo;
